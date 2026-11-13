/**
 * AI setup wizard and provider manager.
 *
 * The wizard opens the provider's sign-up, key or billing page in the default browser. It
 * cannot read that browser: the key comes back by
 *   - OpenRouter sign-in (OAuth PKCE): fully automatic, no copy and paste;
 *   - the clipboard: when the user returns to Anne's Pen after copying a key, the wizard reads
 *     the clipboard once (if allowed), recognizes the key by its format, tests it, saves it and
 *     clears it from the clipboard;
 *   - pasting into the key field.
 */
import { h, icon, clear } from './dom';
import { openDialog, toast, confirmDialog } from './dialog';
import type { App } from '../app';
import { PROVIDERS, providerById, detectKey, FREE_LABEL, type ProviderDef } from '../ai/providers';
import { aiSettings, saveAiSettings, getApiKey, setApiKey, deleteApiKey, maskKey, resolveBaseUrl, qualityModel, type ProviderConfig } from '../ai/store';
import { costNote, MIN_MEMBERS, MAX_MEMBERS, type EnsembleMode } from '../ai/ensemble';
import type { Field } from './dialog';
import { listModels, pickModels, chat, AiError } from '../ai/client';
import { openExternal, readClipboardText, writeClipboardText, onAppResume, isNative, isCapacitor, secureStorageEncrypted } from '../platform/native';

const SECTIONS: { title: string; help: string; ids: string[] }[] = [
  { title: 'Free, no account', help: 'Runs on this device. Nothing you write leaves it.', ids: ['device', 'builtin'] },
  { title: 'Free with a free account', help: 'Cloud models with a free tier. Sign up, create a key, and Anne\'s Pen picks it up.', ids: ['openrouter', 'gemini', 'groq', 'mistral', 'cerebras', 'sambanova', 'zai', 'nvidia', 'cloudflare', 'cohere'] },
  { title: 'On your own computer', help: 'Free open models served from a PC or Mac on your network.', ids: ['ollama', 'lmstudio'] },
  { title: 'Paid services', help: 'Pay-as-you-go keys from the major labs and clouds.', ids: ['openai', 'anthropic', 'deepseek', 'xai', 'perplexity', 'together', 'fireworks', 'huggingface', 'moonshot', 'qwen', 'azure', 'bedrock', 'custom'] },
];

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** Open the wizard. Resolves true when a provider was configured. */
export async function openAiSetup(app: App, opts: { provider?: string; reason?: string } = {}): Promise<boolean> {
  let configured = false;
  const root = h('div', { class: 'qf-ai-wizard' });
  let cleanup: (() => void)[] = [];
  const reset = () => { cleanup.forEach((f) => f()); cleanup = []; };

  const showChooser = () => {
    reset();
    clear(root);
    if (opts.reason) root.append(h('p', { class: 'qf-ai-reason' }, opts.reason));
    root.append(h('p', { class: 'qf-help' }, 'Pick where Anne\'s Pen\'s AI features should run. You can add several and switch at any time (AI ▸ Providers & Models).'));
    const s = aiSettings();
    for (const sec of SECTIONS) {
      root.append(h('h3', null, sec.title), h('p', { class: 'qf-help' }, sec.help));
      const grid = h('div', { class: 'qf-ai-cards' });
      for (const id of sec.ids) {
        const p = providerById(id)!;
        const have = !!s.providers[id];
        grid.append(h('button', { class: 'qf-ai-card' + (have ? ' qf-on' : ''), onclick: () => showProvider(p) },
          h('div', { class: 'qf-ai-card-head' }, h('b', null, p.name), h('span', { class: `qf-ai-badge qf-ai-${p.free}` }, FREE_LABEL[p.free])),
          h('div', { class: 'qf-help' }, p.freeNote),
          have ? h('div', { class: 'qf-ai-set' }, icon('check_circle'), s.active === id ? ' Active' : ' Set up') : null));
      }
      root.append(grid);
    }
  };

  const showProvider = (p: ProviderDef) => {
    reset();
    clear(root);
    root.append(h('button', { class: 'qf-link', onclick: showChooser }, '‹ All providers'));
    root.append(h('h3', null, p.name, ' ', h('span', { class: `qf-ai-badge qf-ai-${p.free}` }, FREE_LABEL[p.free])), h('p', { class: 'qf-help' }, p.freeNote));
    if (p.notes) root.append(h('p', { class: 'qf-warn' }, p.notes));
    if (p.cors === 'no' && !isNative() && !isCapacitor()) root.append(h('p', { class: 'qf-warn' }, 'This service blocks calls from web browsers. Set it up in the Android, iOS or desktop app, or choose another provider here.'));
    if (p.kind === 'local') return showDevice(p);
    if (p.kind === 'builtin') return showBuiltin(p);
    showKeyed(p);
  };

  // ---------------------------------------------------------------- key-based providers
  const showKeyed = (p: ProviderDef) => {
    const existing = aiSettings().providers[p.id];
    const status = h('div', { class: 'qf-ai-status', role: 'status' });
    const say = (msg: string, kind: 'info' | 'ok' | 'err' = 'info') => { status.className = `qf-ai-status qf-ai-${kind}`; status.textContent = msg; };
    const fieldEls: Record<string, HTMLInputElement> = {};
    let fromClipboard = false;
    let waiting = false;

    // Purpose buttons: each opens the right page in the default browser.
    const open = (url: string | undefined, msg: string) => {
      if (!url) return;
      waiting = true;
      openExternal(url);
      say(msg);
    };
    const actions = h('div', { class: 'qf-ai-actions' });
    if (p.oauth === 'openrouter') {
      actions.append(h('button', { class: 'qf-btn qf-primary', onclick: () => void signInOpenRouter() }, icon('login'), ' Sign in with OpenRouter (no copying)'));
    }
    if (p.links.download) actions.append(h('button', { class: 'qf-btn', onclick: () => open(p.links.download, `Install ${p.name} on your computer, start it, then come back and press Test & Save.`) }, icon('download'), ' Download'));
    if (p.needsKey && p.links.keys) {
      if (p.free === 'free' || p.free === 'trial') {
        actions.append(h('button', { class: 'qf-btn', onclick: () => open(p.links.keys || p.links.signup, `Create a free account if asked, create an API key, and copy it. Then come back here${aiSettings().clipboardWatch ? ': Anne\'s Pen will pick the key up from the clipboard' : ' and paste it below'}.`) }, icon('key'), ' Create a free key'));
      }
      actions.append(h('button', { class: 'qf-btn', onclick: () => open(p.links.billing || p.links.keys, `Add a payment method or credits, then create an API key and copy it. Come back here when it is copied.`) }, icon('credit_card'), p.free === 'paid' ? ' Create a paid key' : ' Upgrade to paid'));
      actions.append(h('button', { class: 'qf-btn', onclick: () => open(p.links.keys, p.keyViewable ? 'Copy your existing key from the list, then come back here.' : `${p.name} shows each key only once, when it is created. If you no longer have it, create a new key (and delete the old one), copy it, and come back.`) }, icon('manage_search'), ' Find my existing key'));
    }
    actions.append(h('button', { class: 'qf-link', onclick: () => openExternal(p.links.docs) }, 'Documentation'));
    root.append(actions);

    // Extra fields
    for (const f of p.fields || []) {
      const input = h('input', { type: 'text', class: 'qf-input', placeholder: f.placeholder, value: (existing as any)?.[f.key] || (f.key === 'baseUrl' ? p.baseUrl : '') }) as HTMLInputElement;
      fieldEls[f.key] = input;
      root.append(h('label', { class: 'qf-field' }, h('span', null, f.label), input, f.help ? h('small', { class: 'qf-help' }, f.help) : null));
    }

    // Key field
    const keyInput = h('input', { type: 'password', class: 'qf-input', autocomplete: 'off', spellcheck: 'false', placeholder: p.needsKey ? 'Paste the API key here' : 'API key (optional)' }) as HTMLInputElement;
    const showBtn = h('button', { class: 'qf-iconbtn', title: 'Show or hide', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('visibility'));
    const pasteBtn = h('button', { class: 'qf-btn', onclick: () => void fromClip(true) }, icon('content_paste'), ' Paste');
    if (p.needsKey || p.id === 'custom' || p.id === 'lmstudio' || p.id === 'ollama') {
      root.append(h('label', { class: 'qf-field' }, h('span', null, p.keyLabel || 'API key'), h('div', { class: 'qf-row' }, keyInput, showBtn, pasteBtn)));
      void getApiKey(p.id).then((k) => { if (k) { keyInput.placeholder = `Saved key ${maskKey(k)} (leave empty to keep)`; } });
      const plainNote = h('p', { class: 'qf-hint', hidden: true }, 'API keys are stored unencrypted on this computer (no system keychain is available).');
      root.append(plainNote);
      void secureStorageEncrypted().then((enc) => { plainNote.hidden = enc; });
    }
    const watch = h('input', { type: 'checkbox', checked: aiSettings().clipboardWatch, onchange: () => saveAiSettings((s) => { s.clipboardWatch = watch.checked; }) }) as HTMLInputElement;
    if (p.needsKey) root.append(h('label', { class: 'qf-check' }, watch, ' When I come back to Anne\'s Pen, look for the copied key in the clipboard'));
    const makeActive = h('input', { type: 'checkbox', checked: !aiSettings().active || aiSettings().active === p.id }) as HTMLInputElement;
    root.append(h('label', { class: 'qf-check' }, makeActive, ' Use this provider for AI commands'));
    root.append(h('div', { class: 'qf-row' }, h('button', { class: 'qf-btn qf-primary', onclick: () => void testAndSave() }, icon('verified'), ' Test & Save')), status);

    const fromClip = async (manual: boolean) => {
      const text = await readClipboardText();
      if (text == null) { if (manual) say('The clipboard could not be read here. Long-press the key field and choose Paste.', 'err'); return; }
      const hit = detectKey(text, p.id);
      if (hit && hit.provider === p.id) {
        keyInput.value = hit.key;
        fromClipboard = true;
        say(`Found a ${p.name} key in the clipboard (${maskKey(hit.key)}). Testing…`);
        await testAndSave();
      } else if (hit) {
        const other = providerById(hit.provider)!;
        say(`The clipboard holds what looks like a ${other.name} key, not a ${p.name} key.`, 'err');
        status.append(' ', h('button', { class: 'qf-link', onclick: () => { showProvider(other); } }, `Set up ${other.name} instead`));
      } else if (manual && text.trim()) {
        keyInput.value = text.trim();
        say('Pasted. Press Test & Save.');
      } else if (manual) say('The clipboard is empty.', 'err');
    };

    // Returning from the browser: look for the key once.
    cleanup.push(onAppResume(() => {
      if (!waiting || !aiSettings().clipboardWatch) return;
      waiting = false;
      setTimeout(() => void fromClip(false), 450);
    }));

    const cfgFromFields = (): ProviderConfig => {
      const cfg: ProviderConfig = { ...(existing || { id: p.id, model: p.models.quality, fastModel: p.models.fast }) };
      for (const f of p.fields || []) (cfg as any)[f.key] = fieldEls[f.key].value.trim() || undefined;
      return cfg;
    };

    const testAndSave = async () => {
      const cfg = cfgFromFields();
      const key = keyInput.value.trim() || (await getApiKey(p.id));
      if (p.needsKey && !key && p.id !== 'custom') { say('Enter or paste the API key first.', 'err'); return; }
      if (p.id === 'custom' && !cfg.baseUrl) { say('Enter the base URL of the service.', 'err'); return; }
      say('Contacting ' + host(resolveBaseUrl(p, cfg)) + '…');
      try {
        const models = await listModels({ def: p, cfg, key, baseUrl: resolveBaseUrl(p, cfg) });
        const picked = pickModels(p, models);
        cfg.models = models.slice(0, 500);
        if (!existing || !models.includes(cfg.model)) cfg.model = picked.quality;
        if (!existing || !cfg.fastModel || !models.includes(cfg.fastModel)) cfg.fastModel = picked.fast;
        cfg.verified = Date.now();
        if (key) await setApiKey(p.id, key);
        saveAiSettings((s) => { s.providers[p.id] = cfg; if (makeActive.checked || !s.active) s.active = p.id; });
        configured = true;
        if (fromClipboard && aiSettings().clearClipboard) {
          if (await writeClipboardText('', true)) toast('Key saved and removed from the clipboard');
        }
        showDone(p);
      } catch (e: any) {
        const msg = e instanceof AiError ? e.message : String(e?.message || e);
        say(msg, 'err');
      }
    };

    const signInOpenRouter = async () => {
      try {
        const { startOpenRouterSignIn } = await import('../ai/oauth');
        const session = await startOpenRouterSignIn();
        say('Sign in on openrouter.ai in your browser. Anne\'s Pen receives the key automatically when you approve.');
        const manual = h('input', { type: 'text', class: 'qf-input', placeholder: 'If nothing happens: paste the address from the browser (…?code=…) here' }) as HTMLInputElement;
        const go = h('button', { class: 'qf-btn', onclick: () => session.complete(manual.value).catch((err) => say(String(err.message || err), 'err')) }, 'Finish');
        status.after(h('div', { class: 'qf-row qf-ai-manual' }, manual, go));
        cleanup.push(() => session.cancel());
        const key = await session.key;
        keyInput.value = key;
        say('Signed in. Testing the key…', 'ok');
        await testAndSave();
      } catch (e: any) {
        if (String(e?.message) !== 'Canceled') say(`Sign-in did not complete: ${e?.message || e}`, 'err');
      }
    };

    if (opts.provider === p.id) setTimeout(() => keyInput.focus(), 50);
  };

  // ---------------------------------------------------------------- on-device model
  const showDevice = (p: ProviderDef) => {
    void (async () => {
      const { LOCAL_MODELS, loadLocalModel, onLocalProgress } = await import('../ai/local');
      const cur = aiSettings().providers.device?.model || LOCAL_MODELS[0].id;
      let gpu = 'checking…';
      const gpuLine = h('p', { class: 'qf-help' }, `WebGPU: ${gpu}`);
      try {
        const a = await (navigator as any).gpu?.requestAdapter?.();
        gpu = a ? 'available (faster)' : 'not available — the model will run on the CPU (slower)';
      } catch { gpu = 'not available — the model will run on the CPU (slower)'; }
      gpuLine.textContent = `WebGPU: ${gpu}`;
      const list = h('div', { class: 'qf-ai-models' });
      for (const m of LOCAL_MODELS) {
        list.append(h('label', { class: 'qf-check' }, h('input', { type: 'radio', name: 'qf-local-model', value: m.id, checked: m.id === cur }), ' ', h('b', null, m.label), ` · ${m.size}`, h('div', { class: 'qf-help' }, m.note)));
      }
      const bar = h('progress', { max: 100, value: 0, class: 'qf-ai-progress', hidden: true }) as HTMLProgressElement;
      const status = h('div', { class: 'qf-ai-status', role: 'status' });
      const btn = h('button', { class: 'qf-btn qf-primary' }, icon('download'), ' Download and start');
      root.append(gpuLine, list, h('p', { class: 'qf-help' }, 'The first start downloads the AI library from cdn.jsdelivr.net and the model from huggingface.co. After that it works offline. Use Wi-Fi: the files are large.'), btn, bar, status);
      btn.onclick = async () => {
        const model = (list.querySelector('input:checked') as HTMLInputElement)?.value || LOCAL_MODELS[0].id;
        btn.setAttribute('disabled', '');
        bar.hidden = false;
        const files = new Map<string, { loaded: number; total: number }>();
        const off = onLocalProgress((pr) => {
          if (pr.file && pr.total) files.set(pr.file, { loaded: pr.loaded || 0, total: pr.total });
          let l = 0, t = 0;
          files.forEach((f) => { l += f.loaded; t += f.total; });
          if (t) { bar.value = Math.round((l / t) * 100); status.textContent = `Downloading ${(l / 1048576).toFixed(0)} of ${(t / 1048576).toFixed(0)} MB…`; }
          if (pr.status === 'ready') status.textContent = 'Starting the model…';
        });
        cleanup.push(off);
        try {
          const info = await loadLocalModel(model);
          saveAiSettings((s) => { s.providers.device = { id: 'device', model, fastModel: model, verified: Date.now() }; s.active = 'device'; });
          configured = true;
          status.textContent = `Ready (running with ${info.device === 'webgpu' ? 'WebGPU' : 'WebAssembly on the CPU'}, ${info.dtype}).`;
          showDone(p);
        } catch (e: any) {
          status.className = 'qf-ai-status qf-ai-err';
          status.textContent = String(e?.message || e);
          btn.removeAttribute('disabled');
        } finally { off(); }
      };
    })();
  };

  // ---------------------------------------------------------------- browser built-in model
  const showBuiltin = (p: ProviderDef) => {
    const status = h('div', { class: 'qf-ai-status', role: 'status' });
    const btn = h('button', { class: 'qf-btn qf-primary' }, icon('memory'), ' Check and enable');
    root.append(btn, status);
    btn.onclick = async () => {
      const LM = (globalThis as any).LanguageModel;
      if (!LM) { status.textContent = 'Not available in this browser. It requires desktop Chrome 148 or later (Windows, macOS, Linux, Chromebook Plus) with about 22 GB free disk and 16 GB of memory. Choose another option.'; return; }
      try {
        const a = await LM.availability();
        if (a === 'unavailable') { status.textContent = 'This device does not meet the requirements for the built-in model.'; return; }
        if (a !== 'available') {
          status.textContent = 'Downloading the browser\'s model…';
          const s = await LM.create({ monitor: (m: any) => m.addEventListener('downloadprogress', (e: any) => { status.textContent = `Downloading the browser's model… ${Math.round((e.loaded || 0) * 100)}%`; }) });
          s.destroy?.();
        }
        saveAiSettings((s) => { s.providers.builtin = { id: 'builtin', model: 'default', verified: Date.now() }; s.active = 'builtin'; });
        configured = true;
        showDone(p);
      } catch (e: any) { status.textContent = String(e?.message || e); }
    };
  };

  // ---------------------------------------------------------------- finished
  const showDone = (p: ProviderDef) => {
    reset();
    clear(root);
    const cfg = aiSettings().providers[p.id];
    root.append(h('h3', null, icon('check_circle'), ` ${p.name} is ready`));
    if (cfg?.models?.length && p.kind !== 'local' && p.kind !== 'builtin') {
      const sel = (val: string, onch: (v: string) => void) => {
        const s = h('select', { class: 'qf-input', onchange: (e: Event) => onch((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
        for (const m of cfg.models!) s.append(h('option', { value: m, selected: m === val }, m));
        if (!cfg.models!.includes(val)) s.prepend(h('option', { value: val, selected: true }, val));
        return s;
      };
      root.append(
        h('label', { class: 'qf-field' }, h('span', null, 'Model for writing and analysis'), sel(cfg.model, (v) => saveAiSettings((s) => { s.providers[p.id].model = v; }))),
        h('label', { class: 'qf-field' }, h('span', null, 'Model for quick tasks'), sel(cfg.fastModel || cfg.model, (v) => saveAiSettings((s) => { s.providers[p.id].fastModel = v; }))));
    }
    const out = h('div', { class: 'qf-ai-try' });
    root.append(
      h('p', { class: 'qf-help' }, p.kind === 'local' || p.kind === 'builtin'
        ? 'Text you send to AI commands is processed on this device.'
        : `When you use an AI command, Anne\'s Pen sends the text it needs directly from this device to ${host(resolveBaseUrl(p, cfg || {}))}. Anne\'s Pen has no server of its own. ${p.name}'s terms and privacy policy apply${p.free === 'free' ? '; free tiers may use prompts to improve their models' : ''}.`),
      h('div', { class: 'qf-row' },
        h('button', { class: 'qf-btn', onclick: async () => {
          out.textContent = '…';
          try { await chat({ provider: p.id, tier: 'fast', messages: [{ role: 'user', content: 'Reply with one short friendly sentence confirming you are working.' }], maxTokens: 60, onToken: (_d, full) => { out.textContent = full; } }); }
          catch (e: any) { out.textContent = String(e?.message || e); }
        } }, icon('play_arrow'), ' Try it'),
        h('button', { class: 'qf-btn', onclick: showChooser }, 'Add another provider')),
      out);
  };

  if (opts.provider && providerById(opts.provider)) showProvider(providerById(opts.provider)!);
  else showChooser();
  await openDialog({ title: 'Set Up AI', content: root, wide: true, ok: 'Done', cancel: false });
  reset();
  app.ui.refresh?.();
  return configured || !!aiSettings().active;
}

/** Providers & Models: switch, test, change keys, remove; and AI options. */
export async function openAiProviders(app: App): Promise<void> {
  const root = h('div', { class: 'qf-ai-wizard' });
  const draw = async () => {
    clear(root);
    const s = aiSettings();
    const ids = Object.keys(s.providers);
    if (!ids.length) root.append(h('p', null, 'No AI provider is set up yet.'));
    for (const id of ids) {
      const p = providerById(id);
      if (!p) continue;
      const cfg = s.providers[id];
      const key = p.needsKey ? await getApiKey(id) : '';
      const status = h('span', { class: 'qf-help' });
      root.append(h('div', { class: 'qf-ai-prov' + (s.active === id ? ' qf-on' : '') },
        h('label', { class: 'qf-check' }, h('input', { type: 'radio', name: 'qf-ai-active', checked: s.active === id, onchange: () => { saveAiSettings((x) => { x.active = id; }); void draw(); } }), ' ', h('b', null, p.name)),
        h('div', { class: 'qf-help' }, `Model: ${cfg.model}${cfg.fastModel && cfg.fastModel !== cfg.model ? ` · quick tasks: ${cfg.fastModel}` : ''}${key ? ` · key ${maskKey(key)}` : ''}`),
        h('div', { class: 'qf-row' },
          h('button', { class: 'qf-btn qf-sm', onclick: async () => { status.textContent = 'Testing…'; try { const r = await chat({ provider: id, tier: 'fast', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 10 }); status.textContent = `Working (${r.model}): ${r.text.slice(0, 40)}`; } catch (e: any) { status.textContent = String(e?.message || e); } } }, 'Test'),
          h('button', { class: 'qf-btn qf-sm', onclick: async () => { await openAiSetup(app, { provider: id }); void draw(); } }, 'Change'),
          h('button', { class: 'qf-btn qf-sm', onclick: async () => {
            if (!(await confirmDialog('Remove Provider', `Remove ${p.name} and delete its saved key from this device?`, 'Remove'))) return;
            await deleteApiKey(id);
            saveAiSettings((x) => { delete x.providers[id]; if (x.active === id) x.active = Object.keys(x.providers)[0] || null; });
            void draw();
          } }, 'Remove'),
          status)));
    }
    root.append(h('div', { class: 'qf-row' }, h('button', { class: 'qf-btn qf-primary', onclick: async () => { await openAiSetup(app); void draw(); } }, icon('add'), ' Add a provider')));
  };
  await draw();
  await openDialog({ title: 'AI Providers & Models', content: root, wide: true, ok: 'Close', cancel: false });
  app.ui.refresh?.();
}

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** AI Settings ▸ "Use several AIs": members (with models), master or consensus, master/clerk, rounds, discussion, cost and privacy. */
function ensembleFields(mode?: EnsembleMode): Field[] {
  const s = aiSettings();
  const e = s.ensemble;
  const ids = Object.keys(s.providers).filter((id) => providerById(id));
  const member = (id: string) => e.members.find((m) => m.provider === id);
  const fields: Field[] = [
    { key: 'ensHead', type: 'heading', label: 'Use several AIs' },
    { key: 'ensIntro', type: 'info', html: `<p class="qf-help qf-ens-anchor">Send each AI request to several of the AIs you have set up and get one answer from them. ${ids.length < MIN_MEMBERS ? '<b>Set up at least two AI providers first (AI ▸ Set Up AI).</b>' : `Choose ${MIN_MEMBERS} to ${MAX_MEMBERS}.`} Requests that test a key or list models always use one AI.</p>` },
    { key: 'ensOn', type: 'checkbox', label: 'Use several AIs for AI commands (at least 2 must be chosen)', value: mode ? mode !== 'single' : e.mode !== 'single' },
  ];
  for (const id of ids) {
    const p = providerById(id)!;
    const cfg = s.providers[id];
    fields.push(
      { key: `ens_${id}`, type: 'checkbox', label: p.name, value: !!member(id), half: true },
      { key: `ensModel_${id}`, type: 'combo', label: `${p.name} model`, options: cfg.models?.length ? cfg.models : [qualityModel(id, s)], value: member(id)?.model || qualityModel(id, s), half: true, visibleIf: (v) => !!v[`ens_${id}`] },
    );
  }
  fields.push(
    { key: 'ensMode', type: 'radio', label: 'When several AIs answer', options: [{ value: 'master', label: 'One AI combines the answers (master)' }, { value: 'consensus', label: 'The AIs deliberate until they agree (Quaker consensus)' }], value: mode && mode !== 'single' ? mode : e.mode === 'consensus' ? 'consensus' : 'master' },
    { key: 'ensMaster', type: 'select', label: 'Master / clerk', options: ids.map((id) => ({ value: id, label: providerById(id)!.name })), value: ids.includes(e.master) ? e.master : s.active && ids.includes(s.active) ? s.active : ids[0], half: true },
    { key: 'ensRounds', type: 'number', label: 'Rounds of discussion', min: 1, max: 5, value: e.maxRounds, half: true, visibleIf: (v) => v.ensMode === 'consensus' },
    { key: 'ensShow', type: 'checkbox', label: 'Show the discussion (each AI\'s answer and the rounds, below the result)', value: e.showDeliberation },
    { key: 'ensNotes', type: 'info', html: '<p class="qf-help qf-ens-cost"></p><p class="qf-help qf-ens-privacy"></p>' },
  );
  return fields;
}

/** The members, master and rounds the "Use several AIs" fields describe. */
function ensembleChoice(v: Record<string, any>): { ids: string[]; master: string; rounds: number } {
  const ids = Object.keys(aiSettings().providers).filter((id) => providerById(id) && v[`ens_${id}`]);
  return { ids, master: String(v.ensMaster || ''), rounds: Math.max(1, Math.min(5, Math.round(Number(v.ensRounds) || 3))) };
}

/** Cost note and the list of every service that will receive the text. */
function updateEnsembleNotes(v: Record<string, any>, body: HTMLElement): void {
  const { ids, master, rounds } = ensembleChoice(v);
  const cost = body.querySelector('.qf-ens-cost');
  const priv = body.querySelector('.qf-ens-privacy');
  if (cost) cost.textContent = ids.length >= MIN_MEMBERS ? costNote(ids.length, rounds) : 'Choose at least two AIs.';
  if (!priv) return;
  const all = [...new Set([...ids, ...(master && ids.length >= MIN_MEMBERS ? [master] : [])])];
  const s = aiSettings();
  const list = all.map((id) => {
    const p = providerById(id)!;
    const local = p.kind === 'local' || p.kind === 'builtin';
    return `<li>${escHtml(p.name)}${local ? ' (on this device; the text does not leave it)' : ` (${escHtml(host(resolveBaseUrl(p, s.providers[id] || {})))})`}</li>`;
  });
  priv.innerHTML = all.length ? `<b>Privacy:</b> the text of each AI command, and the other AIs' answers, will be sent to every one of these services; each one's terms and privacy policy apply:<ul>${list.join('')}</ul>` : '';
}

/** AI options. `section: 'ensemble'` scrolls to "Use several AIs"; `mode` preselects master or consensus. */
export async function openAiSettings(app: App, opts: { section?: 'ensemble'; mode?: EnsembleMode } = {}): Promise<void> {
  const s = aiSettings();
  const r = await openDialog({
    title: 'AI Settings', wide: true,
    onOpen: (ctl) => {
      updateEnsembleNotes(ctl.values(), ctl.body);
      // After the dialog has focused its first field (which scrolls to the top).
      if (opts.section === 'ensemble') setTimeout(() => ctl.body.querySelector('.qf-ens-anchor')?.closest('.qf-info')?.previousElementSibling?.scrollIntoView({ block: 'start' }), 150);
    },
    onChange: (v, ctl) => updateEnsembleNotes(v, ctl.body),
    validate: (v) => {
      const { ids } = ensembleChoice(v);
      if (v.ensOn && ids.length < MIN_MEMBERS) return 'To use several AIs, choose at least two of them (or turn "Use several AIs" off).';
      if (ids.length > MAX_MEMBERS) return `Choose at most ${MAX_MEMBERS} AIs.`;
      return null;
    },
    fields: [
      { key: 'enabled', label: 'AI features are on', type: 'checkbox', value: s.enabled },
      { key: 'trackAsRevisions', label: 'Insert AI edits as tracked changes (author "AI (model)") so every change can be reviewed', type: 'checkbox', value: s.trackAsRevisions },
      { key: 'confirmDocument', label: 'Ask before sending a whole document to a cloud service', type: 'checkbox', value: s.confirmDocument },
      { key: 'alternatives', label: 'Versions offered by Rewrite', type: 'number', min: 1, max: 5, value: s.alternatives, half: true },
      { key: 'language', label: 'Language for generated text', type: 'combo', options: ['auto', 'English', 'English (American)', 'English (British)', 'English (Canadian)', 'English (Australian)', 'English (Indian)', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Chinese (Simplified)', 'Japanese', 'Korean'], value: s.language, half: true },
      { key: 'clipboardWatch', label: 'During setup, look for a copied API key when I return to the app', type: 'checkbox', value: s.clipboardWatch },
      { key: 'clearClipboard', label: 'Remove a recognized key from the clipboard after saving it', type: 'checkbox', value: s.clearClipboard },
      { key: 'voiceProfile', label: 'My writing voice (used by Match My Voice)', type: 'textarea', rows: 3, value: s.voiceProfile, placeholder: 'e.g. Warm, plain-spoken, short sentences, occasional dry humor, American spelling' },
      { key: 'styleGuide', label: 'Style guide (used by Check Against Style Guide)', type: 'textarea', rows: 4, value: s.styleGuide, placeholder: 'e.g. Use the serial comma. Spell out numbers under ten. "Email", not "e-mail".' },
      ...ensembleFields(opts.mode),
      { key: 'usage', type: 'info', html: `<p class="qf-help">Requests this device has sent: ${s.usage.requests.toLocaleString()} · tokens in/out (where reported): ${s.usage.tokensIn.toLocaleString()} / ${s.usage.tokensOut.toLocaleString()} · since ${new Date(s.usage.since).toLocaleDateString()}</p>` },
    ],
  });
  if (!r) return;
  saveAiSettings((x) => {
    x.enabled = !!r.enabled; x.trackAsRevisions = !!r.trackAsRevisions; x.confirmDocument = !!r.confirmDocument;
    x.alternatives = Math.max(1, Math.min(5, Number(r.alternatives) || 3)); x.language = String(r.language || 'auto');
    x.clipboardWatch = !!r.clipboardWatch; x.clearClipboard = !!r.clearClipboard; x.voiceProfile = String(r.voiceProfile || ''); x.styleGuide = String(r.styleGuide || '');
    // Several AIs. A model left at the provider's own quality model is not stored, so it follows later changes there.
    const { ids, master, rounds } = ensembleChoice(r);
    x.ensemble.members = ids.map((id) => { const m = String(r[`ensModel_${id}`] || '').trim(); return m && m !== qualityModel(id, x) ? { provider: id, model: m } : { provider: id }; }).slice(0, MAX_MEMBERS);
    x.ensemble.mode = r.ensOn && ids.length >= MIN_MEMBERS ? (r.ensMode === 'consensus' ? 'consensus' : 'master') : 'single';
    if (master) x.ensemble.master = master;
    x.ensemble.maxRounds = rounds;
    x.ensemble.showDeliberation = !!r.ensShow;
  });
  app.ui.refresh?.();
}

export { PROVIDERS };
