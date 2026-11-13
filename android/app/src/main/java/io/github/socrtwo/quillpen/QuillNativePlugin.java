package io.github.socrtwo.quillpen;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.os.Build;
import android.os.PersistableBundle;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native document plumbing for Anne's Pen on Android.
 *
 * JS contract (all binary payloads are base64 strings without line breaks):
 * <ul>
 *   <li>openDocument({mimeTypes: string[]}) -> {uri, name, mime, data} | {canceled: true}</li>
 *   <li>saveAs({name, mime, data}) -> {uri, name} | {canceled: true}</li>
 *   <li>writeUri({uri, data}) -> {ok: true}</li>
 *   <li>readUri({uri}) -> {uri, name, mime, data}</li>
 *   <li>print({jobName}) -> void</li>
 *   <li>share({name, mime, data, title}) -> void</li>
 *   <li>getLaunchFile() -> {uri?, name, mime, data} | {} (consumed once)</li>
 *   <li>keepAwake({on: boolean}) -> void</li>
 *   <li>event "fileOpened" -> same payload as getLaunchFile, for files opened while running</li>
 *   <li>secureSet({key, value}) / secureGet({key}) -> {value} / secureRemove({key}): Keystore-encrypted secrets</li>
 *   <li>readClipboard() -> {text} / writeClipboard({text, sensitive})</li>
 *   <li>startLoopback({timeoutMs, successHtml, path}) -> {port}; event "oauthCallback" {url} (requests for path only); stopLoopback()</li>
 * </ul>
 */
@CapacitorPlugin(name = "QuillNative")
public class QuillNativePlugin extends Plugin {

    private static final String TAG = "QuillNative";
    private static final String EVENT_FILE_OPENED = "fileOpened";
    private static final String SHARE_DIR = "shared";
    private static final long SHARE_FILE_MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    /** Single background thread for file I/O so large documents never block the UI or the plugin queue. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Large payloads waiting for an activity result, kept out of the call's saved state. */
    private static final java.util.Map<String, String> pendingData = new java.util.concurrent.ConcurrentHashMap<>();
    /** Largest document read into memory (bytes); bigger files are refused instead of crashing. */
    private static final long MAX_READ_BYTES = 64L * 1024L * 1024L;

    private AiSupport.Loopback loopback;

    private final Object launchLock = new Object();
    private boolean launchFileConsumed = false;

    @Override
    protected void handleOnDestroy() {
        if (loopback != null) {
            loopback.stop();
        }
        io.shutdown();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // AI setup: secrets, clipboard, OAuth loopback
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void secureSet(PluginCall call) {
        final String key = call.getString("key");
        final String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("secureSet requires 'key' and 'value'");
            return;
        }
        io.execute(() -> {
            try {
                AiSupport.put(getContext(), key, value);
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not store the secret: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("secureGet requires 'key'");
            return;
        }
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                ret.put("value", AiSupport.get(getContext(), key));
            } catch (Throwable e) {
                // A Keystore key lost after a device restore cannot decrypt old values: report none.
                Log.w(TAG, "secureGet failed", e);
                ret.put("value", JSObject.NULL);
            }
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("secureRemove requires 'key'");
            return;
        }
        AiSupport.remove(getContext(), key);
        call.resolve();
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                    ret.put("text", text != null ? text.toString() : JSObject.NULL);
                } else {
                    ret.put("text", JSObject.NULL);
                }
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) {
                    call.reject("No clipboard service");
                    return;
                }
                if ((text == null || text.isEmpty()) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cm.clearPrimaryClip();
                } else {
                    ClipData clip = ClipData.newPlainText("Anne's Pen", text);
                    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        PersistableBundle extras = new PersistableBundle();
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                        clip.getDescription().setExtras(extras);
                    }
                    cm.setPrimaryClip(clip);
                }
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not write the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void startLoopback(PluginCall call) {
        long timeoutMs = call.getLong("timeoutMs", 600_000L);
        String html = call.getString("successHtml");
        String path = call.getString("path");
        synchronized (this) {
            if (loopback != null) {
                loopback.stop();
            }
            try {
                loopback = new AiSupport.Loopback(timeoutMs, html, path, (url) -> {
                    JSObject ev = new JSObject();
                    ev.put("url", url);
                    notifyListeners("oauthCallback", ev, true);
                });
            } catch (Throwable e) {
                call.reject("Could not start the sign-in listener: " + e.getMessage(), asException(e));
                return;
            }
            Thread t = new Thread(loopback, "quillpen-oauth");
            t.setDaemon(true);
            t.start();
            JSObject ret = new JSObject();
            ret.put("port", loopback.port());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void stopLoopback(PluginCall call) {
        synchronized (this) {
            if (loopback != null) {
                loopback.stop();
                loopback = null;
            }
        }
        call.resolve();
    }

    // ---------------------------------------------------------------------------------------------
    // Open / save via the Storage Access Framework
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimeTypes = toStringArray(call.getArray("mimeTypes"));
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        try {
            startActivityForResult(call, intent, "openResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No document picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        if (uri == null) {
            resolveCanceled(call);
            return;
        }
        takePersistablePermission(uri);
        io.execute(() -> {
            try {
                call.resolve(readDocument(uri, null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = call.getString("name", "Untitled");
        String mime = call.getString("mime", "application/octet-stream");
        if (call.getString("data") == null) {
            call.reject("saveAs requires 'data'");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        // Capacitor parcels the call's data into onSaveInstanceState while the picker is up;
        // a large base64 document there exceeds the 1 MB binder limit (TransactionTooLargeException).
        pendingData.put(call.getCallbackId(), call.getString("data"));
        call.getData().remove("data");
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (ActivityNotFoundException e) {
            pendingData.remove(call.getCallbackId());
            call.reject("No document picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        final String data = pendingData.remove(call.getCallbackId());
        if (uri == null) {
            resolveCanceled(call);
            return;
        }
        if (data == null) {
            // The app process was recreated while the picker was open.
            call.reject("The document was not kept while the file picker was open. Please save again.");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(uri, decodeBase64(data));
                takePersistablePermission(uri);
                String name = queryDisplayName(uri);
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", name != null ? name : call.getString("name", ""));
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not save document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeUri(PluginCall call) {
        final String uriString = call.getString("uri");
        final String data = call.getString("data");
        if (uriString == null || uriString.isEmpty() || data == null) {
            call.reject("writeUri requires 'uri' and 'data'");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(checkedUri(Uri.parse(uriString)), decodeBase64(data));
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not write document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void readUri(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("readUri requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                call.resolve(readDocument(checkedUri(Uri.parse(uriString)), null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Print / share / screen
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void print(PluginCall call) {
        final String jobName = call.getString("jobName", "Anne's Pen document");
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Printing is not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not start printing: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        final String title = call.getString("title", name);
        if (data == null) {
            call.reject("share requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(decodeBase64(data));
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);

                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, name);
                send.setClipData(ClipData.newRawUri(name, uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Intent chooser = Intent.createChooser(send, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Sharing is not available right now");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        call.resolve();
                    } catch (ActivityNotFoundException e) {
                        call.reject("No app is available to share with", e);
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not share document: " + e.getMessage(), asException(e));
            }
        });
    }

    /** Sister apps that may receive a file: Anne's Grid, Anne's Post, Anne's Stage (and nothing else). */
    private static boolean isSisterPackage(String pkg) {
        return "io.github.socrtwo.quillgrid".equals(pkg) || "io.github.socrtwo.quillpost".equals(pkg) || "io.github.socrtwo.quillstage".equals(pkg);
    }

    /** Whether a sister app is installed (the manifest's <queries> makes it visible on Android 11+). */
    @PluginMethod
    public void canLaunchApp(PluginCall call) {
        final String pkg = call.getString("package", "");
        JSObject ret = new JSObject();
        ret.put("installed", isSisterPackage(pkg) && getContext().getPackageManager().getLaunchIntentForPackage(pkg) != null);
        call.resolve(ret);
    }

    /**
     * Open a file in a sister app: ACTION_VIEW on the original document URI when there is one
     * (read permission granted to that app only), else on a cache copy shared through FileProvider.
     */
    @PluginMethod
    public void launchApp(PluginCall call) {
        final String pkg = call.getString("package", "");
        final String uriStr = call.getString("uri");
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        if (!isSisterPackage(pkg)) {
            call.reject("Not an Anne's Pen sister app");
            return;
        }
        final Context context = getContext();
        if (context.getPackageManager().getLaunchIntentForPackage(pkg) == null) {
            JSObject ret = new JSObject();
            ret.put("launched", false);
            ret.put("installed", false);
            call.resolve(ret);
            return;
        }
        io.execute(() -> {
            try {
                Uri uri = null;
                if (uriStr != null && uriStr.startsWith("content:")) uri = checkedUri(Uri.parse(uriStr));
                if (uri == null) {
                    if (data == null) throw new IOException("No file to open");
                    File dir = new File(context.getCacheDir(), SHARE_DIR);
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir.getAbsolutePath());
                    pruneOldShares(dir);
                    File file = new File(dir, name);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(decodeBase64(data));
                    }
                    uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                }
                final Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                view.setPackage(pkg);
                view.setClipData(ClipData.newRawUri(name, uri));
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("The app is not in the foreground");
                    return;
                }
                activity.runOnUiThread(() -> {
                    JSObject ret = new JSObject();
                    ret.put("installed", true);
                    try {
                        activity.startActivity(view);
                        ret.put("launched", true);
                    } catch (ActivityNotFoundException e) {
                        // Installed, but it does not accept this file type: open the app itself.
                        Intent launch = context.getPackageManager().getLaunchIntentForPackage(pkg);
                        if (launch != null) activity.startActivity(launch);
                        ret.put("launched", false);
                    }
                    call.resolve(ret);
                });
            } catch (Throwable e) {
                call.reject("Could not open the file in the other app: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.TRUE));
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity not available");
            return;
        }
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Files handed to us by other apps ("Open with" / "Share to")
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Intent launchIntent = null;
        synchronized (launchLock) {
            if (!launchFileConsumed) {
                launchFileConsumed = true;
                Activity activity = getActivity();
                launchIntent = activity != null ? activity.getIntent() : null;
            }
        }
        if (launchIntent == null || !isFileIntent(launchIntent)) {
            call.resolve(new JSObject());
            return;
        }
        final Intent intent = launchIntent;
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                call.resolve(file != null ? file : new JSObject());
            } catch (Throwable e) {
                call.reject("Could not read the launch file: " + e.getMessage(), asException(e));
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) {
            return;
        }
        // BridgeActivity replays the launching intent through onNewIntent() right after the bridge
        // starts. That one is delivered through getLaunchFile() instead, so skip it here.
        Activity activity = getActivity();
        if (activity != null && intent == activity.getIntent()) {
            return;
        }
        if (!isFileIntent(intent)) {
            return;
        }
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                if (file != null) {
                    // retainUntilConsumed: delivered later if the web app has not subscribed yet.
                    notifyListeners(EVENT_FILE_OPENED, file, true);
                }
            } catch (Exception e) {
                Log.e(TAG, "Could not read incoming file", e);
            }
        });
    }

    private static boolean isFileIntent(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            return intent.getData() != null;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return streamExtra(intent) != null || intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null;
        }
        return false;
    }

    private JSObject readIntent(Intent intent) throws IOException {
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamExtra(intent);
            if (uri == null) {
                // Plain text shared without a file: hand it over as a .txt document (no uri).
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null) {
                    return null;
                }
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                String base = subject != null && !subject.trim().isEmpty() ? sanitizeFileName(subject.trim()) : "Shared text";
                JSObject ret = new JSObject();
                ret.put("name", base + ".txt");
                ret.put("mime", "text/plain");
                ret.put("data", Base64.encodeToString(text.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                return ret;
            }
        }
        if (uri == null) {
            return null;
        }
        checkedUri(uri);
        takePersistablePermission(uri);
        return readDocument(uri, intent.getType());
    }

    private static Uri streamExtra(Intent intent) {
        Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uri = clip.getItemAt(0).getUri();
            }
        }
        return uri;
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /**
     * Only content: URIs from other apps' providers. file: URIs and our own providers (FileProvider,
     * embed provider) would let another app or a crafted intent reach this app's private files.
     */
    private Uri checkedUri(Uri uri) throws IOException {
        String authority = uri.getAuthority();
        String pkg = getContext().getPackageName();
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme()) || authority == null
                || authority.equals(pkg) || authority.startsWith(pkg + ".")) {
            throw new IOException("Unsupported document location");
        }
        return uri;
    }

    private JSObject readDocument(Uri uri, String hintMime) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] bytes;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) {
                throw new IOException("Unable to open " + uri);
            }
            bytes = readAll(in);
        }
        String name = queryDisplayName(uri);
        if (name == null || name.isEmpty()) {
            name = "Untitled";
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        ret.put("mime", resolveMime(resolver, uri, name, hintMime));
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return ret;
    }

    private void writeBytes(Uri uri, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream stream = null;
        try {
            // "wt" truncates; not every provider supports it, so fall back to "w".
            stream = resolver.openOutputStream(uri, "wt");
        } catch (Exception e) {
            Log.w(TAG, "openOutputStream(\"wt\") failed, retrying with \"w\": " + e.getMessage());
        }
        if (stream == null) {
            stream = resolver.openOutputStream(uri, "w");
        }
        if (stream == null) {
            throw new IOException("Unable to open " + uri + " for writing");
        }
        try (OutputStream out = stream) {
            out.write(bytes);
            out.flush();
        }
    }

    private String queryDisplayName(Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0 && !cursor.isNull(index)) {
                        String name = cursor.getString(index);
                        if (name != null && !name.isEmpty()) {
                            return name;
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not query display name for " + uri, e);
            }
        }
        String last = uri.getLastPathSegment();
        if (last == null) {
            return null;
        }
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    private static String resolveMime(ContentResolver resolver, Uri uri, String name, String hintMime) {
        String mime = null;
        try {
            mime = resolver.getType(uri);
        } catch (Exception ignored) {
            // Some providers throw for unknown URIs; fall through to the other strategies.
        }
        if (isSpecificMime(mime)) {
            return mime;
        }
        if (isSpecificMime(hintMime)) {
            return hintMime;
        }
        String fromExtension = mimeFromExtension(name);
        if (fromExtension != null) {
            return fromExtension;
        }
        return mime != null ? mime : "application/octet-stream";
    }

    private static boolean isSpecificMime(String mime) {
        return mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime) && !mime.contains("*");
    }

    private static String mimeFromExtension(String name) {
        if (name == null) {
            return null;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return null;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "docx":
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "odt":
                return "application/vnd.oasis.opendocument.text";
            case "rtf":
                return "application/rtf";
            case "md":
            case "markdown":
                return "text/markdown";
            case "txt":
                return "text/plain";
            case "htm":
            case "html":
                return "text/html";
            case "epub":
                return "application/epub+zip";
            case "qpd":
                return "application/x-quillpen";
            default:
                return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        }
    }

    private void takePersistablePermission(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (Exception e) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Not a persistable grant (e.g. a one-off VIEW intent); access lasts for this session.
            }
        }
    }

    private static Uri resultUri(ActivityResult result) {
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            return null;
        }
        Intent data = result.getData();
        return data != null ? data.getData() : null;
    }

    private static Exception asException(Throwable t) {
        return t instanceof Exception ? (Exception) t : new Exception(t.toString(), t);
    }

    private static void resolveCanceled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("canceled", true);
        call.resolve(ret);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buffer = new byte[64 * 1024];
        int read;
        long total = 0;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_READ_BYTES) {
                throw new IOException("File is larger than " + (MAX_READ_BYTES / (1024 * 1024)) + " MB");
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static byte[] decodeBase64(String data) {
        if (data == null) {
            return new byte[0];
        }
        // Tolerate a data: URL prefix ("data:<mime>;base64,....").
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        String payload = comma >= 0 ? data.substring(comma + 1) : data;
        return Base64.decode(payload, Base64.DEFAULT);
    }

    private static String[] toStringArray(JSArray array) {
        List<String> out = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                Object value = array.opt(i);
                if (value instanceof String && !((String) value).isEmpty()) {
                    out.add((String) value);
                }
            }
        }
        return out.toArray(new String[0]);
    }

    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "document";
        }
        return cleaned;
    }

    private static void pruneOldShares(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - SHARE_FILE_MAX_AGE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff && !f.delete()) {
                Log.w(TAG, "Could not delete old shared file " + f.getName());
            }
        }
    }
}
