import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, test, expect, type BrowserContext, type Page } from '@playwright/test';
import ts from 'typescript';
import type { CaptureResult } from '../../apps/extension/src/page-editor';

const productionPath = resolve('dist/extension');
const workspace = resolve('test-results/extension-browser');
let server: Server;
let fixtureUrl: string;
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Extension form QA</title>
<body><form id="ordinary"><label>Message <textarea id="message">Hello world</textarea></label>
<input id="password" type="password" value="never capture">
<input id="card" autocomplete="cc-number" value="4111111111111111">
<input id="readonly" readonly value="keep original">
<div id="editable" tabindex="0" contenteditable="plaintext-only">Hello world</div>
<div id="rich" tabindex="0" contenteditable="true"><strong>Hello</strong> world</div></form>
<script>window.submits=0;window.inputs=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submits++});document.addEventListener('input',()=>window.inputs++);</script>
</body></html>`;

function extensionId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

async function launch(path: string): Promise<BrowserContext> {
  const profile = await mkdtemp(join(workspace, 'profile-'));
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
}

async function popup(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId(path)}/index.html`);
  await expect(page.getByRole('button', { name: '入力欄を読み取る' })).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  await mkdir(workspace, { recursive: true });
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no address');
  fixtureUrl = `http://127.0.0.1:${address.port}/form`;
});
test.afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); });

test('production popup renders under its MV3 CSP and can start its local Worker and WASM', async () => {
  const context = await launch(productionPath);
  try {
    const errors: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const external: string[] = [];
    context.on('request', (request) => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await page.goto(`chrome-extension://${extensionId(productionPath)}/index.html`);
    await expect(page.getByRole('button', { name: '入力欄を読み取る' })).toBeVisible();
    await expect(page.getByLabel('原文', { exact: true })).toBeVisible();
    const workerFile = (await readdir(join(productionPath, 'assets'))).find((name) => /^worker-.*\.js$/.test(name));
    expect(workerFile).toBeTruthy();
    const workerResult = await page.evaluate(async (file) => {
      return new Promise<{ type: string; code?: string }>((resolveResult, reject) => {
        const worker = new Worker(`./assets/${file}`, { type: 'module' });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker did not respond')); }, 20_000);
        worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
        worker.onmessage = (event: MessageEvent<{ type: string; code?: string }>) => {
          if (event.data.type === 'ERROR' || event.data.type === 'READY') {
            clearTimeout(timer); worker.terminate(); resolveResult(event.data);
          }
        };
        worker.postMessage({ type: 'INIT', runtimeUrl: new URL('runtime/', document.baseURI).href });
        worker.postMessage({ type: 'LOAD_MODEL', requestId: 'extension-browser-test', model: 'toEnglish' });
      });
    }, workerFile!);
    expect(workerResult).toMatchObject({ type: 'ERROR', code: 'model-missing' });
    const wasm = await page.evaluate(async () => {
      const response = await fetch(new URL('runtime/ort-wasm-simd-threaded.wasm', document.baseURI));
      const bytes = await response.arrayBuffer();
      const module = await WebAssembly.compile(bytes);
      return { bytes: bytes.byteLength, valid: module instanceof WebAssembly.Module };
    });
    expect(wasm.valid).toBe(true);
    expect(wasm.bytes).toBeGreaterThan(1_000_000);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('isolated scripting API captures and safely replaces actual Chrome fields', async () => {
  // Toolbar activeTab grants need a user gesture in Chrome's toolbar. For this
  // automated scripting test only, grant the copied extension our fixture host.
  // The distributed manifest remains activeTab+scripting only.
  const harnessPath = await mkdtemp(join(workspace, 'extension-harness-'));
  await cp(productionPath, harnessPath, { recursive: true });
  const manifest = JSON.parse(await readFile(join(harnessPath, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(harnessPath, 'manifest.json'), JSON.stringify(manifest));
  const editorSource = await readFile(resolve('apps/extension/src/page-editor.ts'), 'utf8');
  await writeFile(join(harnessPath, 'test-page-editor.js'), ts.transpileModule(editorSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  await writeFile(join(harnessPath, 'test-harness.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="test-harness.js"></script>');
  await writeFile(join(harnessPath, 'test-harness.js'), `import { capturePageText, replacePageText } from './test-page-editor.js';
    window.extensionHarness={
      async findTab(url){return (await chrome.tabs.query({})).find(tab=>tab.url===url).id;},
      async capture(tabId){return (await chrome.scripting.executeScript({target:{tabId},func:capturePageText}))[0].result;},
      async replace(tabId,token,expected,replacement){return (await chrome.scripting.executeScript({target:{tabId},func:replacePageText,args:[token,expected,replacement]}))[0].result;}
    };`);
  const context = await launch(harnessPath);
  try {
    await popup(context, harnessPath);
    const target = await context.newPage();
    await target.goto(fixtureUrl);
    const harness = await context.newPage();
    await harness.goto(`chrome-extension://${extensionId(harnessPath)}/test-harness.html`);
    await harness.waitForFunction(() => 'extensionHarness' in window);
    const tabId = await harness.evaluate(async (url) => {
      const api = (window as unknown as { extensionHarness: { findTab(url: string): Promise<number> } }).extensionHarness;
      return api.findTab(url);
    }, fixtureUrl);
    const capture = async (): Promise<CaptureResult> => harness.evaluate(async (id) => {
      const api = (window as unknown as { extensionHarness: { capture(id: number): Promise<CaptureResult> } }).extensionHarness;
      return api.capture(id);
    }, tabId);
    const replace = async (captured: CaptureResult, text: string) => harness.evaluate(async ({ id, captured, text }) => {
      const api = (window as unknown as { extensionHarness: { replace(id: number, token: string, original: string, text: string): Promise<{ok: boolean; reason?: string}> } }).extensionHarness;
      return api.replace(id, captured.token!, captured.text!, text);
    }, { id: tabId, captured, text });

    await target.locator('#message').focus();
    await target.locator('#message').evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(6, 11));
    const selected = await capture();
    expect(selected).toMatchObject({ ok: true, text: 'world' });
    expect(selected.token).toBeTruthy();
    expect(await replace(selected, 'мир')).toEqual({ ok: true });
    await expect(target.locator('#message')).toHaveValue('Hello мир');
    expect(await replace(selected, 'reuse')).toMatchObject({ ok: false });
    const events = await target.evaluate(() => ({
      submits: (window as unknown as {submits: number}).submits,
      inputs: (window as unknown as {inputs: number}).inputs,
    }));
    expect(events).toEqual({ submits: 0, inputs: 1 });

    const stale = await capture();
    await target.locator('#message').fill('New user text');
    expect(await replace(stale, 'must not overwrite')).toMatchObject({ ok: false });
    await expect(target.locator('#message')).toHaveValue('New user text');

    for (const selector of ['#password', '#card', '#readonly']) {
      await target.locator(selector).focus();
      expect((await capture()).token).toBeUndefined();
    }
    await expect(target.locator('#password')).toHaveValue('never capture');
    await expect(target.locator('#card')).toHaveValue('4111111111111111');

    await target.locator('#editable').focus();
    await target.locator('#editable').evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 6); range.setEnd(element.firstChild!, 11);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    });
    const editable = await capture();
    expect(editable).toMatchObject({ ok: true, text: 'world' });
    expect(await replace(editable, '世界')).toEqual({ ok: true });
    await expect(target.locator('#editable')).toHaveText('Hello 世界');

    await target.locator('#rich').focus();
    expect((await capture()).token).toBeUndefined();
    await expect(target.locator('#rich')).toHaveText('Hello world');
  } finally { await context.close(); }
});
