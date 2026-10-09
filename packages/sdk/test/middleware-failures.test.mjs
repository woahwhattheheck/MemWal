import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fixture } from './fixtures/middleware-client.mjs';
register(new URL('./fixtures/middleware-loader.mjs', import.meta.url));
const { withMemWal } = await import('../dist/ai/middleware.js');
const params = {prompt:[{role:'user',content:[{type:'text',text:'I like tea.'}]}]};
function setup(overrides = {}, options = {}) {
    fixture.client = {recall:async()=>({results:[]}), analyze:async()=>({job_ids:[]}), ...overrides};
    return withMemWal({specificationVersion:'v3'}, {key:'test-only', ...options});
}
const generate = (model, p = params) => model.hooks.wrapGenerate({params:p, doGenerate:async()=>({text:'reply'})});

test('a settled failed save is reported by flush once, without retrying the write', async () => {
    let attempts=0;
    const original=Object.assign(new Error('fixture 429'), {status:429});
    const events=[];
    const model=setup({analyze:async()=>{attempts++;throw original;}}, {onMemoryError:e=>events.push(e)});
    assert.equal((await generate(model)).text,'reply');
    await nextTurn(); // also exercise errors that settled before flush was called
    await assert.rejects(model.flush(), e=>e.name==='MemWalAutoSaveError' && e.failureCount===1 && e.cause===original);
    assert.equal(attempts,1);
    assert.equal(events.length,1);
    assert.equal(events[0].operation,'autoSave');
    assert.equal(events[0].error,original);
    await model.flush();
});

test('a recall failure invokes the error callback while preserving fail-open response', async () => {
    const original=new Error('fixture recall outage');
    const events=[];
    const model=setup({recall:async()=>{throw original;}}, {onMemoryError:e=>events.push(e)});
    assert.equal(await model.hooks.transformParams({params}),params);
    assert.equal(events.length,1);
    assert.equal(events[0].operation,'recall');
    assert.equal(events[0].error,original);
});

test('default diagnostics and failing async callbacks omit raw error content', async () => {
    const warnings=[];
    const saved=console.warn;
    console.warn=(...values)=>warnings.push(values.join(' '));
    try {
        const sensitive=new Error('fixture-private-text-do-not-log');
        const client={recall:async()=>{throw sensitive;}};
        const defaultModel=setup(client);
        assert.equal(await defaultModel.hooks.transformParams({params}),params);
        const callbackModel=setup(client, {onMemoryError:async()=>{throw sensitive;}});
        assert.equal(await callbackModel.hooks.transformParams({params}),params);
        await nextTurn();
        assert.equal(warnings.length,2);
        assert.ok(warnings.every(w=>!w.includes('fixture-private-text-do-not-log')));
    } finally { console.warn=saved; }
});

test('tool continuation does not resave old input; a new equal user prompt still saves', async () => {
    const texts=[];
    const model=setup({analyze:async text=>texts.push(text)});
    const continuation={prompt:[...params.prompt,{role:'assistant',content:[]},{role:'tool',content:[]}]};
    await generate(model);
    await generate(model,continuation);
    await model.hooks.wrapStream({params:continuation,doStream:async()=>({stream:'fixture'})});
    await model.hooks.wrapStream({params,doStream:async()=>({stream:'fixture'})});
    await model.flush();
    assert.deepEqual(texts,['I like tea.','I like tea.']);
});

test('flush waits for pending acceptance without blocking the generated reply', async () => {
    let resolve;
    const acceptance=new Promise(r=>{resolve=r;});
    const model=setup({analyze:()=>acceptance});
    assert.equal((await generate(model)).text,'reply');
    let flushed=false;
    const flush=model.flush().then(()=>{flushed=true;});
    await nextTurn();
    assert.equal(flushed,false);
    resolve({job_ids:['accepted-not-stored']});
    await flush;
    assert.equal(flushed,true);
});

test('recall keeps the trust boundary and autoSave=false starts no write', async () => {
    let saves=0;
    const model=setup({recall:async()=>({results:[{text:'fixture memory',distance:0.1}]}),analyze:async()=>{saves++;}}, {autoSave:false});
    const enriched=await model.hooks.transformParams({params});
    assert.equal(enriched.prompt[0].role,'system');
    assert.ok(!enriched.prompt[0].content.includes('fixture memory'));
    assert.equal(enriched.prompt.at(-1),params.prompt[0]);
    assert.match(JSON.stringify(enriched.prompt),/BEGIN_UNTRUSTED_WALRUS_MEMORY_/);
    await generate(model,enriched);
    await model.flush();
    assert.equal(saves,0);
});
