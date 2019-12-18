const { parse, serialize } = require('parse5');
const { queryAll, predicates, getAttribute, setAttribute, cloneNode, remove, insertBefore } = require('@open-wc/building-utils/dom5-fork');
const { extractScripts } = require('../utils/extract-scripts');
const { appEntryTypes } = require('../utils/constants');
const path = require('path');
const deepmerge = require('deepmerge');
const { append, query, predicates } = require('@open-wc/building-utils/dom5-fork');
const { createScript, createElement } = require('../utils/utils');
const { getPolyfills } = require('../loader/create-polyfills-info');
const { createPolyfillsLoader } = require('../loader/create-polyfills-loader');
const { minifyIndexHTML, defaultMinifyHTMLConfig } = require('./minify-index-html');
const { cleanImportPath } = require('../utils/utils');

/** @typedef {import('parse5').ASTNode} ASTNode */
/** @typedef {import('../loader/create-polyfills-loader').PolyfillsLoaderConfig} PolyfillsLoaderConfig */
/** @typedef {import('../loader/create-polyfills-loader').AppEntries} AppEntries */

/**
 * @typedef {object} TransformIndexHTMLConfig
 * @property {AppEntries} entries
 * @property {AppEntries} [legacyEntries]
 * @property {PolyfillsLoaderConfig} [polyfills]
 * @property {boolean|object} [minify] false=disabled, true=default config, object=custom config
 * @property {string[]} [preloadFiles]
 */

/**
 * @typedef {object} FileResult
 * @property {string} path
 * @property {string} content
 */

/** @type {Partial<TransformIndexHTMLConfig>} */
const defaultConfig = {
  minify: defaultMinifyHTMLConfig,
};

/**
 *
 * @param {ASTNode} indexHTML
 * @param {TransformIndexHTMLConfig} config
 */
function injectPolyfilledImportMaps(indexHTML, config,) {
  const importMaps = queryAll(indexHTML, predicates.hasTagName('script')).filter(s => getAttribute(s, 'type') === 'importmap');
  const entryTypes = [config.entries.type, config.legacyEntries && config.legacyEntries.type];

  /** @param {string} type */
  function inject(type) {
    importMaps.forEach((importMap) => {
      const newImportMap = cloneNode(importMap);
      setAttribute(newImportMap, 'type', type);
      insertBefore(importMap.parent, importMap, newImportMap);
    });
  }

  if (entryTypes.includes(appEntryTypes.moduleShim)) {
    inject('importmap-shim');
  }

  if (entryTypes.includes(appEntryTypes.systemjs)) {
    inject('systemjs-importmap');
  }

  if (!entryTypes.includes(appEntryTypes.module)) {
    importMaps.forEach((importMap) => {
      remove(importMap);
    });
  }
}


/**
 * If we don't need a polyfills loader, creates scripts to be loaded
 *
 * @param {AppEntries} entries
 * @returns {ASTNode[]}
 */
function createScripts(entries) {
  return entries.files.map(entry => createScript({
    src: cleanImportPath(entry),
    type: entries.type === 'module' ? 'module' : undefined,
  }));
}

/**
 * Generates an index HTML based on the given configuration. A clean index.html should be
 *
 * @param {string | ASTNode} baseIndex the base index.html
 * @param {Partial<InjectPolyfillsLoaderConfig>} config
 * @returns {{ indexHTML: string, files: FileResult[] }} the updated index html
 */
function injectPolyfillsLoader(baseIndex, config) {
  if (typeof baseIndex === 'string') {
    baseIndex = parse(baseIndex);
  }
  const localConfig = deepmerge(defaultConfig, config);

  if (!localConfig.entries || !localConfig.entries.files.length) {
    throw new Error('Invalid config: missing config.entries');
  }

  const head = query(baseIndex, predicates.hasTagName('head'));
  const body = query(baseIndex, predicates.hasTagName('body'));

  if (!head || !body) {
    throw new Error(`Invalid index.html: missing <head> or <body>`);
  }

  /** @type {FileResult[]} */
  const files = [];
  const polyfills = localConfig.polyfills ? getPolyfills(localConfig.polyfills, !!localConfig.minify) : [];

  /**
   * Check whether we need add a special loader script, or if we can load app
   * code directly with a script tag. A loader is needed when:
   * - We need to load polyfills
   * - We are loading systemjs, which can't be loaded with a script tag
   * - We have a legacy build, so we need to conditionally load either modern or legacy
   */
  const needsLoader =
    polyfills.length > 0 ||
    [localConfig.entries, localConfig.legacyEntries].some(c => c && c.type === 'system') ||
    (localConfig.legacyEntries && localConfig.legacyEntries.files.length > 0);

  if (!needsLoader) {
    createScripts(localConfig.entries).forEach(script => {
      append(body, script);
    });
  }

  const appendPreloadScript = href => {
    if (localConfig.entries.type === 'module') {
      append(
        head,
        createElement('link', { rel: 'preload', href, as: 'script', crossorigin: 'anonymous' }),
      );
    } else {
      append(head, createElement('link', { rel: 'preload', href, as: 'script' }));
    }
  };

  let loaderCode;
  if (needsLoader) {
    loaderCode = createPolyfillsLoader(
      localConfig.entries,
      localConfig.legacyEntries,
      polyfills,
      !!localConfig.minify,
    );

    localConfig.entries.files.forEach(appendPreloadScript);

    append(body, createScript(null, loaderCode));
  }

  if (localConfig.preloadFiles) {
    localConfig.preloadFiles.forEach(appendPreloadScript);
  }

  const serialized = serialize(baseIndex);
  const result = localConfig.minify ? minifyIndexHTML(serialized, localConfig.minify) : serialized;

  polyfills.forEach(polyfill => {
    files.push({
      path: path.join('polyfills', `${polyfill.name}.${polyfill.hash}.js`),
      content: polyfill.code,
    });
    files.push({
      path: path.join('polyfills', `${polyfill.name}.${polyfill.hash}.js.map`),
      content: polyfill.sourcemap,
    });
  });

  return {
    indexHTML: result,
    files,
  };
}

/**
 * Transforms an index.html file, injecting a polyfills loader for
 * compatibility with older browsers.
 *
 * @param {string} indexHTMLString
 * @param {Partial<InjectPolyfillsLoaderConfig>} config
 */
function transformIndexHTML(indexHTMLString, config) {
  const indexHTML = parse(indexHTMLString);

  const { inlineJsModules, jsModules } = extractScripts(indexHTML, { removeImportMaps: false });
  if (config.entries) {
    config.entries.files = jsModules;
  }

  injectPolyfilledImportMaps(indexHTML, config);

  return z(indexHTML, config);
}

module.exports = {
  transformIndexHTML,
};
