package io.github.socrtwo.quillpen;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Support for the AI setup wizard:
 * <ul>
 *   <li>Secret storage: values are encrypted with AES-256-GCM using a key that lives in the
 *       Android Keystore (never exported), and the ciphertext is kept in private SharedPreferences.</li>
 *   <li>A one-shot loopback HTTP listener on 127.0.0.1 that receives an OAuth redirect from the
 *       default browser (OpenRouter's PKCE flow accepts localhost callbacks).</li>
 * </ul>
 */
final class AiSupport {

    private static final String TAG = "QuillNative";
    private static final String KEY_ALIAS = "quillpen.secrets.v1";
    private static final String PREFS = "quillpen.secure";

    private AiSupport() {}

    // ---------------------------------------------------------------------------------------------
    // Keystore-backed secrets

    private static SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(
                new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            kg.generateKey();
        }
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }

    static void put(Context ctx, String name, String value) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
        String stored = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
        prefs(ctx).edit().putString(name, stored).apply();
    }

    static String get(Context ctx, String name) throws Exception {
        String stored = prefs(ctx).getString(name, null);
        if (stored == null) {
            return null;
        }
        int sep = stored.indexOf(':');
        if (sep < 0) {
            return null;
        }
        byte[] iv = Base64.decode(stored.substring(0, sep), Base64.NO_WRAP);
        byte[] ct = Base64.decode(stored.substring(sep + 1), Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        return new String(c.doFinal(ct), StandardCharsets.UTF_8);
    }

    static void remove(Context ctx, String name) {
        prefs(ctx).edit().remove(name).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------------------------------------------------------------------------------------------
    // OAuth loopback listener

    interface UrlCallback {
        void onUrl(String url);
    }

    static final class Loopback implements Runnable {
        private final ServerSocket server;
        private final long deadline;
        private final String html;
        private final String expectedPath;
        private final UrlCallback callback;
        private volatile boolean running = true;

        /**
         * @param expectedPath the nonce path of this sign-in ("/callback/{nonce}"); other requests to
         *     the port get a 404 and the listener keeps waiting, so another app cannot end the sign-in.
         */
        Loopback(long timeoutMs, String html, String expectedPath, UrlCallback callback) throws Exception {
            this.server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            this.server.setSoTimeout(1000);
            this.deadline = System.currentTimeMillis() + Math.max(10_000L, timeoutMs);
            this.html = html != null ? html : "<!doctype html><body><p>You can return to Anne&#39;s Pen.</p></body>";
            this.expectedPath = expectedPath;
            this.callback = callback;
        }

        int port() {
            return server.getLocalPort();
        }

        void stop() {
            running = false;
            try {
                server.close();
            } catch (Exception ignored) {
                // already closed
            }
        }

        @Override
        public void run() {
            try {
                while (running && System.currentTimeMillis() < deadline) {
                    Socket s;
                    try {
                        s = server.accept();
                    } catch (SocketTimeoutException e) {
                        continue;
                    }
                    if (handle(s)) {
                        break;
                    }
                }
            } catch (Exception e) {
                if (running) {
                    Log.w(TAG, "OAuth loopback stopped", e);
                }
            } finally {
                stop();
            }
        }

        /** Returns true once a request carrying a query string (the redirect) was handled. */
        private boolean handle(Socket s) {
            try (Socket sock = s) {
                sock.setSoTimeout(5000);
                BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                String line = in.readLine();
                if (line == null) {
                    return false;
                }
                String[] parts = line.split(" ");
                String path = parts.length > 1 ? parts[1] : "/";
                int q = path.indexOf('?');
                boolean ours = expectedPath == null || (q >= 0 ? path.substring(0, q) : path).equals(expectedPath);
                boolean isRedirect = ours && q >= 0 && (path.contains("code=") || path.contains("error="));
                byte[] body = (isRedirect ? html : "").getBytes(StandardCharsets.UTF_8);
                String head = (isRedirect ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found") + "\r\n"
                    + "Content-Type: text/html; charset=utf-8\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Connection: close\r\n"
                    + "Content-Length: " + body.length + "\r\n\r\n";
                OutputStream out = sock.getOutputStream();
                out.write(head.getBytes(StandardCharsets.UTF_8));
                out.write(body);
                out.flush();
                if (isRedirect) {
                    callback.onUrl("http://127.0.0.1:" + port() + path);
                    return true;
                }
            } catch (Exception e) {
                Log.w(TAG, "OAuth loopback request failed", e);
            }
            return false;
        }
    }
}
