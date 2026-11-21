const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return { getLatest: () => value, subscribe(callback) { listeners.add(callback); callback(value); return { cancel() { listeners.delete(callback); } }; },
    set(next) { value = next; listeners.forEach(callback => callback(value)); }, listeners };
}
function fixture() {
  const camera = observable({ position: { x: 10, y: 1.6, z: -20 }, rotation: { x: 0, y: 90 }, sweep: 'sweep-v2', mode: 'mode.inside', projection: [1, 0, 1] });
  const sweep = observable({ id: 'sweep-v2', sid: 'sweep-v1', enabled: true, floorInfo: { id: 'native-floor', sequence: 0 } });
  const app = observable({ phase: 'appphase.playing' });
  let actualModel = 'model-a', capture = async () => 'data:image/jpeg;base64,YWJj';
  let captures = 0, moves = 0, creations = 0;
  const points = [{ id: 'sweep-v2', sid: 'sweep-v1', uuid: 'sweep-uuid', enabled: true,
    position: { x: 10, y: 1.6, z: -20 }, floorInfo: { id: 'native-floor', sequence: 0 } },
    { sid: 'disabled', enabled: false, position: { x: 11, y: 1.6, z: -20 } }];
  const sdk = { Model: { getDetails: async () => ({ sid: actualModel }), getData: async () => ({ sweeps: points }) },
    Camera: { pose: camera, setRotation() { moves++; throw Error('No camera changes allowed'); } },
    Sweep: { current: sweep, moveTo() { moves++; throw Error('No camera changes allowed'); } },
    App: { state: app, Phase: { PLAYING: 'appphase.playing' } },
    Renderer: { takeScreenShot(resolution, visibility) { captures++; assert.deepEqual(plain(resolution), { width: 480, height: 270 }); assert.deepEqual(plain(visibility), { mattertags: false, sweeps: false }); return capture(); } } };
  const context = { window: null, document: { getElementById: () => null, createElement() { creations++; throw Error('No iframe creation allowed'); } },
    console, setTimeout(callback, delay) { return setTimeout(callback, delay === 120 ? 1 : delay); }, clearTimeout,
    WF: { cfg: { matterport_model_id: 'model-a', floors: [{ id: 'nav-floor' }] }, building: { slug: 'uncc-main-campus' } },
    WFNavmeshRoute: { floorAt(height, floors) { assert.equal(height, 1.6); return floors[0]; } }, sdk };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.replace('  window.MpPreview = {', `
    mpSdk = window.sdk; modelId = "model-a";
    window.__stepCaptureTest = {
      replaceSdk(next) { mpSdk = next; viewerEpoch++; },
      newGeneration() { viewerEpoch++; },
      focus() { focusGen++; },
      play(on) { playing = on; },
      cache() { const state = stepImageSession(mpSdk); return { entries: state.images.size, bytes: state.bytes }; }
    };
    window.MpPreview = {`), context);
  const binding = { building_slug: 'uncc-main-campus', model_id: 'model-a', sweep_id: 'sweep-v2', floor_id: 'nav-floor',
    position: { x: 10, y: 20, z: 1.6 }, rotation: { pitch: 0, yaw: 90 } };
  return { context, sdk, camera, sweep, app, points, binding,
    model: value => { actualModel = value; }, capture: callback => { capture = callback; },
    counts: () => ({ captures, moves, creations }),
    listeners: () => camera.listeners.size + sweep.listeners.size + app.listeners.size,
    api: context.MpPreview, hook: context.__stepCaptureTest };
}

test('context verifies actual model and transforms SDK Y-up into NavMe Z-up without confusing native floors', async () => {
  const f = fixture(), result = plain(await f.api.getStepImageContext());
  assert.equal(result.status, 'verified');
  assert.equal(result.capture_supported, true);
  assert.equal(result.model_id, 'model-a');
  assert.equal(result.activeSweep, 'sweep-v2');
  assert.deepEqual(result.position, { x: 10, y: 20, z: 1.6 });
  assert.equal(result.sweeps.length, 1);
  assert.equal(result.sweeps[0].floor_id, 'nav-floor');
  assert.equal(result.sweeps[0].native_floor_id, 'native-floor');
  assert.deepEqual(result.sweeps[0].aliases, ['sweep-v2', 'sweep-v1', 'sweep-uuid']);
  assert.equal(f.listeners(), 0);
  assert.deepEqual(f.counts(), { captures: 0, moves: 0, creations: 0 });
  f.model('other-model');
  assert.equal((await f.api.getStepImageContext()).reason, 'model_mismatch');
});

test('current-view capture binds exact sweep, floor, position and orientation and shares concurrent work', async () => {
  const f = fixture(), pose = plain(f.camera.getLatest());
  const [a, b] = await Promise.all([f.api.captureStepImage(f.binding), f.api.captureStepImage(f.binding)]);
  assert.deepEqual(plain(a), plain(b));
  assert.equal(a.status, 'verified');
  assert.equal(a.image.source, 'sdk-current-view');
  assert.equal(a.image.verified, true);
  assert.deepEqual(plain(a.image.position), f.binding.position);
  assert.deepEqual(plain(a.image.rotation), f.binding.rotation);
  assert.equal(a.image.sweep_id, f.binding.sweep_id);
  assert.equal(a.image.floor_id, f.binding.floor_id);
  assert.deepEqual(f.counts(), { captures: 1, moves: 0, creations: 0 });
  assert.deepEqual(plain(f.camera.getLatest()), pose);
  assert.equal((await f.api.captureStepImage(f.binding)).status, 'verified');
  assert.equal(f.counts().captures, 1, 'identical stable capture reuses bounded cache');
  assert.equal(f.listeners(), 0);
});

for (const [label, change, reason] of [
  ['wrong model', f => f.model('other-model'), 'model_mismatch'],
  ['wrong building', f => { f.binding.building_slug = 'other-campus'; }, 'model_mismatch'],
  ['missing sweep', f => { f.binding.sweep_id = 'not-a-sweep'; }, 'missing_sweep'],
  ['disabled sweep', f => { f.binding.sweep_id = 'disabled'; }, 'missing_sweep'],
  ['wrong floor', f => { f.binding.floor_id = 'another-floor'; }, 'floor_mismatch'],
  ['unknown floor', f => { f.context.WF.cfg.floors = []; }, 'unknown_floor'],
  ['wrong route height', f => { f.binding.position.z = 0; }, 'pose_mismatch'],
  ['wrong facing', f => { f.binding.rotation.yaw = 100; }, 'pose_mismatch'],
  ['Dollhouse', f => f.camera.set({ ...f.camera.getLatest(), mode: 'mode.dollhouse' }), 'pose_mismatch'],
  ['transition', f => f.sweep.set({ sid: '', enabled: true }), 'viewer_moving'],
  ['disabled active sweep', f => f.sweep.set({ ...f.sweep.getLatest(), enabled: false }), 'viewer_moving'],
  ['model loading', f => f.app.set({ phase: 'appphase.loading' }), 'viewer_not_ready'],
  ['preview playing', f => f.hook.play(true), 'viewer_moving'],
  ['capture unsupported', f => { f.sdk.Renderer = null; }, 'capture_unsupported']
]) test(`rejects ${label} without screenshot or camera changes`, async () => {
  const f = fixture(); change(f);
  assert.equal((await f.api.captureStepImage(f.binding)).reason, reason);
  assert.deepEqual(f.counts(), { captures: 0, moves: 0, creations: 0 });
  assert.equal(f.listeners(), 0);
});

test('known aliases and wrapped yaw match the exact same SDK sweep', async () => {
  const f = fixture(); f.binding.sweep_id = 'sweep-v1'; f.binding.rotation.yaw = -270;
  assert.equal((await f.api.captureStepImage(f.binding)).status, 'verified');
});

for (const change of ['rotation', 'position', 'sweep', 'projection', 'away-and-back', 'generation', 'focus', 'sdk']) {
  test(`rejects ${change} changes during capture and cleans subscriptions`, async () => {
    const f = fixture(), wait = deferred(), started = deferred();
    f.capture(() => { started.resolve(); return wait.promise; });
    const task = f.api.captureStepImage(f.binding);
    await started.promise;
    const before = f.camera.getLatest();
    if (change === 'rotation') f.camera.set({ ...before, rotation: { x: 0, y: 91 } });
    if (change === 'position') f.camera.set({ ...before, position: { ...before.position, x: 10.05 } });
    if (change === 'sweep') f.sweep.set({ id: '', sid: '', enabled: true });
    if (change === 'projection') f.camera.set({ ...before, projection: [2, 0, 1] });
    if (change === 'away-and-back') { f.camera.set({ ...before, rotation: { x: 0, y: 120 } }); f.camera.set(before); }
    if (change === 'generation') f.hook.newGeneration();
    if (change === 'focus') f.hook.focus();
    if (change === 'sdk') f.hook.replaceSdk({});
    wait.resolve('data:image/jpeg;base64,YWJj');
    const result = await task;
    assert.equal(result.status, 'missing');
    assert.equal(result.reason, ['generation', 'focus', 'sdk'].includes(change) ? 'stale_context' : 'viewer_moving');
    assert.equal(f.listeners(), 0);
    assert.equal(f.counts().moves, 0);
    assert.equal(f.counts().creations, 0);
  });
}

test('capture failures and non-image responses never escape or enter the image cache', async () => {
  const f = fixture();
  for (const capture of [async () => { throw Error('renderer failed'); }, async () => 'https://unverified.example/image.jpg', async () => 'data:image/png;base64,YWJj']) {
    f.capture(capture);
    assert.equal((await f.api.captureStepImage(f.binding)).reason, 'capture_failed');
    assert.equal(f.hook.cache().entries, 0);
    assert.equal(f.listeners(), 0);
  }
});

test('cache stays bounded by image count and mobile memory budget', async () => {
  const f = fixture();
  f.capture(async () => 'data:image/jpeg;base64,' + 'A'.repeat(160000));
  for (let i = 0; i < 21; i++) {
    f.binding.rotation.yaw = 90 + i / 10;
    assert.equal((await f.api.captureStepImage(f.binding)).status, 'verified');
  }
  assert.ok(f.hook.cache().entries <= 16);
  assert.ok(f.hook.cache().bytes <= 3 * 1024 * 1024);
  assert.equal(f.listeners(), 0);
});

test('generation changes during metadata lookup cannot publish stale context', async () => {
  const f = fixture(), wait = deferred();
  f.sdk.Model.getDetails = () => wait.promise;
  const result = f.api.getStepImageContext();
  await flush(); f.hook.newGeneration(); wait.resolve({ sid: 'model-a' });
  assert.equal((await result).reason, 'stale_context');
  assert.equal(f.listeners(), 0);
});
