// Exercise real compiled middleware hooks without network, credentials or ai.
// These are hook-level unit tests, not AI SDK/provider integration tests.
const wrapModule = 'export const wrapLanguageModel = ({model,middleware}) => ({...model,hooks:middleware});';
export async function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/dist/ai/middleware.js')) {
        if (specifier === 'ai') {
            return {url: 'data:text/javascript,' + encodeURIComponent(wrapModule), shortCircuit:true};
        }
        if (specifier === '../memwal.js') {
            return {url: new URL('./middleware-client.mjs', import.meta.url).href, shortCircuit:true};
        }
    }
    return nextResolve(specifier, context);
}
