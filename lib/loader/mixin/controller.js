'use strict';

const path = require('path');
const is = require('is-type-of');
const utility = require('utility');
const utils = require('../../utils');
const FULLPATH = require('../file_loader').FULLPATH;


module.exports = {

  // 加载 Controller
  loadController(opt) {
    this.timing.start('Load Controller');
    opt = Object.assign({
      caseStyle: 'lower',
      directory: path.join(this.options.baseDir, 'app/controller'),
      initializer: (obj, opt) => {  // 导出对象的时候做的预处理，obj 就是对象的对象本身
        // return class if it exports a function
        // ```js
        // module.exports = app => {
        //   return class HomeController extends app.Controller {};
        // }
        // ```
        // 如果对象是个普通函数，则直接将 this.app 注入生成一个新的对象
        if (is.function(obj) && !is.generatorFunction(obj) && !is.class(obj) && !is.asyncFunction(obj)) {
          obj = obj(this.app);
        }
        
        // 如果对象是一个类型
        if (is.class(obj)) {
          obj.prototype.pathName = opt.pathName;
          obj.prototype.fullPath = opt.path;
          // 遍历对象中的所有方法，修改方法的上下文对象，将方法修改为 async function(ctx,next)的方式，返回的是包含处理后所有方法的对象
          return wrapClass(obj);
        }
        if (is.object(obj)) {
          return wrapObject(obj, opt.path);
        }
        // support generatorFunction for forward compatbility
        if (is.generatorFunction(obj) || is.asyncFunction(obj)) {
          return wrapObject({ 'module.exports': obj }, opt.path)['module.exports'];
        }
        return obj;
      },
    }, opt);
    const controllerBase = opt.directory;

    this.loadToApp(controllerBase, 'controller', opt);
    this.options.logger.info('[egg:loader] Controller loaded: %s', controllerBase);
    this.timing.end('Load Controller');
  },

};

// wrap the class, yield a object with middlewares
function wrapClass(Controller) {
  let proto = Controller.prototype;
  const ret = {};
  // 遍历原型链
  while (proto !== Object.prototype) {
    // 获取对象的是所有属性名称
    const keys = Object.getOwnPropertyNames(proto);
    for (const key of keys) {
      // 忽略构造函数，不做任何处理
      if (key === 'constructor') {
        continue;
      }

      const d = Object.getOwnPropertyDescriptor(proto, key);
      // 获取对象属性的描述内容，跳过 get ，set 和 非函数的属性
      // 对过滤后的函数属性，使用 methodToMiddleware 二次处理并且添加到 ret 对象上
      if (is.function(d.value) && !ret.hasOwnProperty(key)) {
        ret[key] = methodToMiddleware(Controller, key);
        ret[key][FULLPATH] = Controller.prototype.fullPath + '#' + Controller.name + '.' + key + '()';
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return ret;

  function methodToMiddleware(Controller, key) {
    // 返回一个闭包函数，在每次请求调用的时候执行，重新实例和注入新的 this，这部分很重要
    return function classControllerMiddleware(...args) {
      // 实例化 controller 注入 this ，这个 this 就是 EggCore 的 this，所以 controller 可以通过 this.ctx 获取上下文对象
      // 返回的闭包函数在执行的时候的this，就是这里传入的this
      const controller = new Controller(this);
      if (!this.app.config.controller || !this.app.config.controller.supportParams) {
        args = [ this ];
      }
      // 调用 call 方法重新设置方法的this，并且传入指定参数
      // 返回的方法会变成 async function(ctx,next),并且this对象为EggCore
      return utils.callFn(controller[key], args, controller);
    };
  }
}

// wrap the method of the object, method can receive ctx as it's first argument
function wrapObject(obj, path, prefix) {
  const keys = Object.keys(obj);
  const ret = {};
  for (const key of keys) {
    if (is.function(obj[key])) {
      const names = utility.getParamNames(obj[key]);
      if (names[0] === 'next') {
        throw new Error(`controller \`${prefix || ''}${key}\` should not use next as argument from file ${path}`);
      }
      ret[key] = functionToMiddleware(obj[key]);
      ret[key][FULLPATH] = `${path}#${prefix || ''}${key}()`;
    } else if (is.object(obj[key])) {
      ret[key] = wrapObject(obj[key], path, `${prefix || ''}${key}.`);
    }
  }
  return ret;

  function functionToMiddleware(func) {
    const objectControllerMiddleware = async function(...args) {
      if (!this.app.config.controller || !this.app.config.controller.supportParams) {
        args = [ this ];
      }
      return await utils.callFn(func, args, this);
    };
    for (const key in func) {
      objectControllerMiddleware[key] = func[key];
    }
    return objectControllerMiddleware;
  }
}
