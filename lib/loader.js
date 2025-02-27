const { interpolateName, getOptions } = require('loader-utils');
const urlSlug = require('url-slug');
const SVGCompiler = require('svg-baker');

const { NAMESPACE } = require('./config');
const configure = require('./configurator');
const Exceptions = require('./exceptions');

let svgCompiler = new SVGCompiler();

// eslint-disable-next-line consistent-return
module.exports = function loader(content) {
  if (this.cacheable) {
    this.cacheable();
  }

  const done = this.async();
  const loaderContext = this;
  const { resourcePath, loaderIndex } = loaderContext;
  // webpack 1 compat
  const resourceQuery = loaderContext.resourceQuery || '';
  const compiler = loaderContext._compiler;
  const isChildCompiler = compiler.isChild();
  const parentCompiler = isChildCompiler ? compiler.parentCompilation.compiler : null;
  const matchedRules = getOptions(loaderContext);

  if (!content.includes('<svg')) {
    throw new Exceptions.InvalidSvg(content, matchedRules);
  }

  const configObj = { context: loaderContext };

  configObj.config = matchedRules;
  configObj.target = loaderContext.target;

  /**
   * @type {SVGSpriteLoaderConfig}
   */
  const config = configure(configObj);

  if (config.extract) {
    const plugin = parentCompiler
      ? parentCompiler.options.plugins.find(p => p.NAMESPACE && p.NAMESPACE === NAMESPACE)
      : this[NAMESPACE];

    if (typeof plugin === 'undefined') {
      throw new Exceptions.ExtractPluginMissingException();
    }

    svgCompiler = plugin.svgCompiler;
  }

  let runtimeGenerator;
  try {
    runtimeGenerator = require(config.runtimeGenerator); // eslint-disable-line import/no-dynamic-require,global-require
  } catch (e) {
    throw new Exceptions.InvalidRuntimeException(e.message);
  }

  let id;
  if (typeof config.symbolId === 'function') {
    id = config.symbolId(resourcePath, resourceQuery);
  } else {
    const idPattern = config.symbolId + (resourceQuery ? `--${urlSlug(resourceQuery)}` : '');
    id = interpolateName(loaderContext, idPattern, {
      content,
      context: compiler.context,
      regExp: config.symbolRegExp
    });
  }
  svgCompiler.addSymbol({ id, content, path: resourcePath + resourceQuery })
    .then((symbol) => {
      const runtime = runtimeGenerator({ symbol, config, context: loaderContext.context, loaderContext });
      done(null, runtime);
    }).catch(done);
};

module.exports.NAMESPACE = NAMESPACE;
