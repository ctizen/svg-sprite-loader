/* eslint-disable import/no-extraneous-dependencies */
const merge = require('deepmerge');
const Promise = require('bluebird');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const SVGCompiler = require('svg-baker');
const spriteFactory = require('svg-baker/lib/sprite-factory');
const Sprite = require('svg-baker/lib/sprite');
const { NAMESPACE } = require('./config');
const {
  MappedList,
  replaceInModuleSource,
  replaceSpritePlaceholder,
  getMatchedRule
} = require('./utils');

const defaultConfig = {
  plainSprite: false,
  spriteAttrs: {}
};

class SVGSpritePlugin {
  constructor(cfg = {}) {
    const config = merge.all([defaultConfig, cfg]);
    this.config = config;

    const spriteFactoryOptions = {
      attrs: config.spriteAttrs
    };

    if (config.plainSprite) {
      spriteFactoryOptions.styles = false;
      spriteFactoryOptions.usages = false;
    }

    this.factory = ({ symbols }) => {
      const opts = merge.all([spriteFactoryOptions, { symbols }]);
      return spriteFactory(opts);
    };

    this.svgCompiler = new SVGCompiler();
    this.rules = {};
  }

  /**
   * This need to find plugin from loader context
   */
  // eslint-disable-next-line class-methods-use-this
  get NAMESPACE() {
    return NAMESPACE;
  }

  getReplacements() {
    const isPlainSprite = this.config.plainSprite === true;
    const replacements = this.map.groupItemsBySymbolFile((acc, item) => {
      acc[item.resource] = isPlainSprite ? item.url : item.useUrl;
    });
    return replacements;
  }

  // TODO optimize MappedList instantiation in each hook
  apply(compiler) {
    this.rules = getMatchedRule(compiler);

    const path = this.rules.outputPath ? this.rules.outputPath : this.rules.publicPath;
    this.filenamePrefix = path
      ? path.replace(/^\//, '')
      : '';

    if (compiler.hooks) {
      compiler.hooks
        .thisCompilation
        .tap(NAMESPACE, (compilation) => {
          try {
            const NormalModule = compiler.webpack.NormalModule;
            NormalModule.getCompilationHooks(compilation).loader
              .tap(NAMESPACE, loaderContext => loaderContext[NAMESPACE] = this);
          } catch (e) {
            compilation.hooks
              .normalModuleLoader
              .tap(NAMESPACE, loaderContext => loaderContext[NAMESPACE] = this);
          }

          compilation.hooks
            .afterOptimizeChunks
            .tap(NAMESPACE, () => this.afterOptimizeChunks(compilation));

          if (compilation.hooks.optimizeExtractedChunks) {
            compilation.hooks
              .optimizeExtractedChunks
              .tap(NAMESPACE, chunks => this.optimizeExtractedChunks(chunks));
          }

          compilation.hooks
            .additionalAssets
            .tapPromise(NAMESPACE, () => {
              return this.additionalAssets(compilation);
            });
        });

      compiler.hooks
        .compilation
        .tap(NAMESPACE, (compilation) => {
          const hooks = HtmlWebpackPlugin.getHooks(compilation);
          if (hooks.beforeAssetTagGeneration) {
            hooks
              .beforeAssetTagGeneration
              .tapAsync(NAMESPACE, (htmlPluginData, callback) => {
                htmlPluginData.assets.sprites = this.beforeHtmlGeneration(compilation);

                callback(null, htmlPluginData);
              });
          }

          if (hooks.beforeHtmlProcessing) {
            compilation.hooks
              .beforeHtmlProcessing
              .tapAsync(NAMESPACE, (htmlPluginData, callback) => {
                htmlPluginData.html = this.beforeHtmlProcessing(htmlPluginData);

                callback(null, htmlPluginData);
              });
          }
        });
    } else {
      // Handle only main compilation
      compiler.plugin('this-compilation', (compilation) => {
        // Share svgCompiler with loader
        compilation.plugin('normal-module-loader', (loaderContext) => {
          loaderContext[NAMESPACE] = this;
        });

        // Replace placeholders with real URL to symbol (in modules processed by svg-sprite-loader)
        compilation.plugin('after-optimize-chunks', () => this.afterOptimizeChunks(compilation));

        // Hook into extract-text-webpack-plugin to replace placeholders with real URL to symbol
        compilation.plugin('optimize-extracted-chunks', chunks => this.optimizeExtractedChunks(chunks));

        // Hook into html-webpack-plugin to add `sprites` variable into template context
        compilation.plugin('html-webpack-plugin-before-html-generation', (htmlPluginData, done) => {
          htmlPluginData.assets.sprites = this.beforeHtmlGeneration(compilation);

          done(null, htmlPluginData);
        });

        // Hook into html-webpack-plugin to replace placeholders with real URL to symbol
        compilation.plugin('html-webpack-plugin-before-html-processing', (htmlPluginData, done) => {
          htmlPluginData.html = this.beforeHtmlProcessing(htmlPluginData);
          done(null, htmlPluginData);
        });

        // Create sprite chunk
        compilation.plugin('additional-assets', (done) => {
          return this.additionalAssets(compilation)
            .then(() => {
              done();
              return true;
            })
            .catch(e => done(e));
        });
      });
    }
  }

  additionalAssets(compilation) {
    const itemsBySprite = this.map.groupItemsBySpriteFilename();
    const filenames = Object.keys(itemsBySprite);

    return Promise.map(filenames, (filename) => {
      const spriteSymbols = itemsBySprite[filename].map(item => item.symbol);

      return Sprite.create({
        symbols: spriteSymbols,
        factory: this.factory
      })
        .then((sprite) => {
          const content = sprite.render();

           compilation.assets[`${this.filenamePrefix}${filename}`] = {
            source() { return content; },
            size() { return content.length; },
            updateHash(bulkUpdateDecorator) { bulkUpdateDecorator.update(content); }
          };
        });
    });
  }

  afterOptimizeChunks(compilation) {
    const { symbols } = this.svgCompiler;
    this.map = new MappedList(symbols, compilation);
    const replacements = this.getReplacements();
    this.map.items.forEach(item => replaceInModuleSource(item.module, replacements));
  }

  optimizeExtractedChunks(chunks) {
    const replacements = this.getReplacements();

    chunks.forEach((chunk) => {
      let modules;

      if (chunk.modulesIterable) {
        modules = Array.from(chunk.modulesIterable);
      } else {
        modules = chunk.modules;
      }

      modules
        // dirty hack to identify modules extracted by extract-text-webpack-plugin
        // TODO refactor
        .filter(module => '_originalModule' in module)
        .forEach(module => replaceInModuleSource(module, replacements));
    });
  }

  beforeHtmlGeneration(compilation) {
    const itemsBySprite = this.map.groupItemsBySpriteFilename();

    const sprites = Object.keys(itemsBySprite).reduce((acc, filename) => {
      acc[this.filenamePrefix + filename] = compilation.assets[this.filenamePrefix + filename].source();
      return acc;
    }, {});

    return sprites;
  }

  beforeHtmlProcessing(htmlPluginData) {
    const replacements = this.getReplacements();
    return replaceSpritePlaceholder(htmlPluginData.html, replacements);
  }
}

module.exports = SVGSpritePlugin;
