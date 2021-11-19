'use strict';

const assert = require('assert');
const fs = require('fs');
const debug = require('debug')('egg-core:loader');
const path = require('path');
const globby = require('globby');
const is = require('is-type-of');
const deprecate = require('depd')('egg');
const utils = require('../utils');
const FULLPATH = Symbol('EGG_LOADER_ITEM_FULLPATH');
const EXPORTS = Symbol('EGG_LOADER_ITEM_EXPORTS');

const defaults = {
  directory: null,
  target: null,
  match: undefined,
  ignore: undefined,
  lowercaseFirst: false,
  caseStyle: 'camel',
  initializer: null,
  call: true,
  override: false,
  inject: undefined,
  filter: null,
};

/**
 * Load files from directory to target object.
 * @since 1.0.0
 */
class FileLoader {

  /**
   * @class
   * @param {Object} options - options
   * @param {String|Array} options.directory - directories to be loaded
   * @param {Object} options.target - attach the target object from loaded files
   * @param {String} options.match - match the files when load, support glob, default to all js files
   * @param {String} options.ignore - ignore the files when load, support glob
   * @param {Function} options.initializer - custom file exports, receive two parameters, first is the inject object(if not js file, will be content buffer), second is an `options` object that contain `path`
   * @param {Boolean} options.call - determine whether invoke when exports is function
   * @param {Boolean} options.override - determine whether override the property when get the same name
   * @param {Object} options.inject - an object that be the argument when invoke the function
   * @param {Function} options.filter - a function that filter the exports which can be loaded
   * @param {String|Function} options.caseStyle - set property's case when converting a filepath to property list.
   */
  constructor(options) {
    assert(options.directory, 'options.directory is required');
    assert(options.target, 'options.target is required');

    this.options = Object.assign({}, defaults, options);

    // compatible old options _lowercaseFirst_
    if (this.options.lowercaseFirst === true) {
      deprecate('lowercaseFirst is deprecated, use caseStyle instead');
      this.options.caseStyle = 'lower';
    }
  }

  /**
   * attach items to target object. Mapping the directory to properties.
   * 将解析文件属性附加到目标对象。解析目录路径映射到属性上，例如下面。
   * `app/controller/group/repository.js` => `target.group.repository`
   * @return {Object} target
   * @since 1.0.0
   */
  load() {
    const items = this.parse();
    const target = this.options.target;
    for (const item of items) {
      debug('loading item %j', item);
      // item { properties: [ 'a', 'b', 'c'], exports }
      // => target.a.b.c = exports
      item.properties.reduce((target, property, index) => {
        let obj;
        const properties = item.properties.slice(0, index + 1).join('.');
        if (index === item.properties.length - 1) {
          if (property in target) {
            if (!this.options.override) throw new Error(`can't overwrite property '${properties}' from ${target[property][FULLPATH]} by ${item.fullpath}`);
          }
          obj = item.exports;
          if (obj && !is.primitive(obj)) {
            obj[FULLPATH] = item.fullpath;
            obj[EXPORTS] = true;
          }
        } else {
          obj = target[property] || {};
        }
        target[property] = obj;
        debug('loaded %s', properties);
        return obj;
      }, target);
    }
    return target;
  }

  /**
   * 解析来自给定目录的文件，然后返回项目列表，每个项目包含属性和导出内容，下面是例子内容
   * For example, parse `app/controller/group/repository.js`
   *
   * ```
   * module.exports = app => {
   *   return class RepositoryController extends app.Controller {};
   * }
   * ```
   *
   * It returns a item
   *
   * ```
   * {
   *   properties: [ 'group', 'repository' ],
   *   exports: app => { ... },
   * }
   * ```
   *
   * `Properties` 是包含FilePath目录的数组。
   *
   * `Exports` depends on type, if exports is a function, it will be called. if initializer is specified, it will be called with exports for customizing.
   * “Exports” 取决于类型，如果导出是一个函数，将被调用。如果指定了初始化程序，则将调用导出进行自定义。
   * @return {Array} items
   * @since 1.0.0
   */
  parse() {
    let files = this.options.match;
    if (!files) {
      files = (process.env.EGG_TYPESCRIPT === 'true' && utils.extensions['.ts'])
        ? [ '**/*.(js|ts)', '!**/*.d.ts' ]
        : [ '**/*.js' ];
    } else {
      files = Array.isArray(files) ? files : [ files ];
    }

    let ignore = this.options.ignore;
    if (ignore) {
      ignore = Array.isArray(ignore) ? ignore : [ ignore ];
      ignore = ignore.filter(f => !!f).map(f => '!' + f);
      files = files.concat(ignore);
    }

    let directories = this.options.directory;
    if (!Array.isArray(directories)) {
      directories = [ directories ];
    }

    const filter = is.function(this.options.filter) ? this.options.filter : null;
    const items = [];
    debug('parsing %j', directories);
    for (const directory of directories) {
      // 解析目录下的所有文件，返回所有文件相对地址
      const filepaths = globby.sync(files, { cwd: directory });
      for (const filepath of filepaths) {
        const fullpath = path.join(directory, filepath);
        if (!fs.statSync(fullpath).isFile()) continue;
        // 通过文件路径获取属性
        // app/service/foo/bar.js => [ 'foo', 'bar' ]
        const properties = getProperties(filepath, this.options);
        // app/service/foo/bar.js => service.foo.bar
        const pathName = directory.split(/[/\\]/).slice(-1) + '.' + properties.join('.');
        // get exports from the file
        const exports = getExports(fullpath, this.options, pathName);

        // ignore exports when it's null or false returned by filter function
        if (exports == null || (filter && filter(exports) === false)) continue;

        // set properties of class
        if (is.class(exports)) {
          exports.prototype.pathName = pathName;
          exports.prototype.fullPath = fullpath;
        }

        // 返回对象包含：完整文件地址，通过文件转化获得的属性数组，导出的文件内容
        items.push({ fullpath, properties, exports });
        debug('parse %s, properties %j, export %j', fullpath, properties, exports);
      }
    }

    return items;
  }

}

module.exports = FileLoader;
module.exports.EXPORTS = EXPORTS;
module.exports.FULLPATH = FULLPATH;

// 将文件路径转换为属性数组
// a/b/c.js => ['a', 'b', 'c']
function getProperties(filepath, { caseStyle }) {
  // if caseStyle is function, return the result of function
  if (is.function(caseStyle)) {
    const result = caseStyle(filepath);
    assert(is.array(result), `caseStyle expect an array, but got ${result}`);
    return result;
  }
  // use default camelize
  return defaultCamelize(filepath, caseStyle);
}

// Get exports from filepath
// If exports is null/undefined, it will be ignored
function getExports(fullpath, { initializer, call, inject }, pathName) {
  let exports = utils.loadFile(fullpath);
  // 执行实例化前的初始化函数配置
  if (initializer) {
    exports = initializer(exports, { path: fullpath, pathName });
  }

  // return exports when it's a class or generator
  //
  // module.exports = class Service {};
  // or
  // module.exports = function*() {}
  if (is.class(exports) || is.generatorFunction(exports) || is.asyncFunction(exports)) {
    return exports;
  }

  // return exports after call when it's a function
  //
  // module.exports = function(app) {
  //   return {};
  // }
  if (call && is.function(exports)) {
    exports = exports(inject);
    if (exports != null) {
      return exports;
    }
  }

  // return exports what is
  return exports;
}

function defaultCamelize(filepath, caseStyle) {
  const properties = filepath.substring(0, filepath.lastIndexOf('.')).split('/');
  return properties.map(property => {
    if (!/^[a-z][a-z0-9_-]*$/i.test(property)) {
      throw new Error(`${property} is not match 'a-z0-9_-' in ${filepath}`);
    }

    // use default camelize, will capitalize the first letter
    // foo_bar.js > FooBar
    // fooBar.js  > FooBar
    // FooBar.js  > FooBar
    // FooBar.js  > FooBar
    // FooBar.js  > fooBar (if lowercaseFirst is true)
    property = property.replace(/[_-][a-z]/ig, s => s.substring(1).toUpperCase());
    let first = property[0];
    switch (caseStyle) {
      case 'lower':
        first = first.toLowerCase();
        break;
      case 'upper':
        first = first.toUpperCase();
        break;
      case 'camel':
      default:
    }
    return first + property.substring(1);
  });
}
