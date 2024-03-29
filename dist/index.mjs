import sirv from 'sirv';
import path from 'node:path';
import fs from 'node:fs';
import chokidar from 'chokidar';
import colors from 'picocolors';
import url from 'url';
import fg from 'fast-glob';
import Mock from 'mockjs';
import { pathToRegexp, match } from 'path-to-regexp';
import { bundleRequire, JS_EXT_RE } from 'bundle-require';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'node:url';

const toString = Object.prototype.toString;
function is(val, type) {
  return toString.call(val) === `[object ${type}]`;
}
function isFunction(val) {
  return is(val, "Function") || is(val, "AsyncFunction");
}
function isArray(val) {
  return val && Array.isArray(val);
}
function isRegExp(val) {
  return is(val, "RegExp");
}
function isAbsPath(path) {
  if (!path) {
    return false;
  }
  if (/^([a-zA-Z]:\\|\\\\|(?:\/|\uFF0F){2,})/.test(path)) {
    return true;
  }
  return /^\/[^/]/.test(path);
}
function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("");
    }, time);
  });
}

const excludeMock = /* @__PURE__ */ new Set();
let mockData = [];
async function createMockServer(opt = { mockPath: "mock", configPath: "vite.mock.config" }, config) {
  opt = {
    mockPath: "mock",
    watchFiles: true,
    configPath: "vite.mock.config.ts",
    logger: true,
    cors: true,
    ...opt
  };
  if (mockData.length > 0)
    return;
  mockData = await getMockConfig(opt, config);
  await createWatch(opt, config);
}
async function requestMiddleware(opt) {
  const { logger = true } = opt;
  const middleware = async (req, res, next) => {
    let queryParams = {};
    if (req.url) {
      queryParams = url.parse(req.url, true);
    }
    const reqUrl = queryParams.pathname;
    const matchRequest = mockData.find((item) => {
      if (excludeMock.has(`${item.url}+${item.method || "get"}`)) {
        return false;
      }
      if (!reqUrl || !item || !item.url) {
        return false;
      }
      if (item.method && item.method.toUpperCase() !== req.method) {
        return false;
      }
      return pathToRegexp(item.url).test(reqUrl);
    });
    if (matchRequest) {
      const isGet = req.method && req.method.toUpperCase() === "GET";
      const { response, rawResponse, timeout, statusCode, url: url2 } = matchRequest;
      if (timeout) {
        await sleep(timeout);
      }
      const urlMatch = match(url2, { decode: decodeURIComponent });
      let query = queryParams.query;
      if (reqUrl) {
        if (isGet && JSON.stringify(query) === "{}" || !isGet) {
          const params = urlMatch(reqUrl).params;
          if (JSON.stringify(params) !== "{}") {
            query = urlMatch(reqUrl).params || {};
          } else {
            query = queryParams.query || {};
          }
        }
      }
      const self = { req, res, parseJson: parseJson.bind(null, req) };
      if (isFunction(rawResponse)) {
        await rawResponse.bind(self)(req, res);
      } else {
        const body = await parseJson(req);
        res.setHeader("Content-Type", "application/json");
        if (opt) {
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        }
        res.statusCode = statusCode || 200;
        const mockResponse = isFunction(response) ? response.bind(self)({ url: req.url, body, query, headers: req.headers }) : response;
        res.end(JSON.stringify(Mock.mock(mockResponse)));
      }
      logger && loggerOutput("request invoke", req.url);
      return;
    }
    next();
  };
  return middleware;
}
function createWatch(opt, config) {
  const { configPath, logger, watchFiles } = opt;
  if (!watchFiles) {
    return;
  }
  const { absConfigPath, absMockPath } = getPath(opt);
  if (process.env.VITE_DISABLED_WATCH_MOCK === "true") {
    return;
  }
  const watchDir = [];
  const exitsConfigPath = fs.existsSync(absConfigPath);
  exitsConfigPath && configPath ? watchDir.push(absConfigPath) : watchDir.push(absMockPath);
  const watcher = chokidar.watch(watchDir, {
    ignoreInitial: true,
    // ignore files generated by `bundle require`
    ignored: "**/_*.bundled_*.(mjs|cjs)"
  });
  watcher.on("all", async (event, file) => {
    logger && loggerOutput(`mock file ${event}`, file);
    mockData = await getMockConfig(opt, config);
  });
}
function parseJson(req) {
  return new Promise((resolve) => {
    let body = "";
    let jsonStr = "";
    req.on("data", function(chunk) {
      body += chunk;
    });
    req.on("end", function() {
      try {
        jsonStr = JSON.parse(body);
      } catch (err) {
        jsonStr = "";
      }
      resolve(jsonStr);
      return;
    });
  });
}
async function getMockConfig(opt, config) {
  const { absConfigPath, absMockPath } = getPath(opt);
  const { ignore, configPath, logger } = opt;
  let ret = [];
  if (configPath && fs.existsSync(absConfigPath)) {
    logger && loggerOutput(`load mock data from`, absConfigPath);
    ret = await resolveModule(absConfigPath, config);
    return ret;
  }
  const mockFiles = fg.sync(`**/*.{ts,mjs,js}`, {
    cwd: absMockPath
  }).filter((item) => {
    if (!ignore) {
      return true;
    }
    if (isFunction(ignore)) {
      return !ignore(item);
    }
    if (isRegExp(ignore)) {
      return !ignore.test(path.basename(item));
    }
    return true;
  });
  try {
    ret = [];
    const resolveModulePromiseList = [];
    for (let index = 0; index < mockFiles.length; index++) {
      const mockFile = mockFiles[index];
      resolveModulePromiseList.push(resolveModule(path.join(absMockPath, mockFile), config));
    }
    const loadAllResult = await Promise.all(resolveModulePromiseList);
    for (const resultModule of loadAllResult) {
      let mod = resultModule;
      if (!isArray(mod)) {
        mod = [mod];
      }
      ret = [...ret, ...mod];
    }
  } catch (error) {
    loggerOutput(`mock reload error`, error);
    ret = [];
  }
  return ret;
}
const getOutputFile = (filepath, format) => {
  const dirname = path.dirname(filepath);
  const basename = path.basename(filepath);
  const randomname = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  return path.resolve(
    dirname,
    `_${basename.replace(JS_EXT_RE, `.bundled_${randomname}.${format === "esm" ? "mjs" : "cjs"}`)}`
  );
};
async function resolveModule(p, config) {
  const mockData2 = await bundleRequire({
    filepath: p,
    getOutputFile
  });
  let mod = mockData2.mod.default || mockData2.mod;
  if (isFunction(mod)) {
    mod = await mod({ env: config.env, mode: config.mode, command: config.command });
  }
  return mod;
}
function getPath(opt) {
  const { mockPath, configPath } = opt;
  const cwd = process.cwd();
  const absMockPath = isAbsPath(mockPath) ? mockPath : path.join(cwd, mockPath || "");
  const absConfigPath = path.join(cwd, configPath || "");
  return {
    absMockPath,
    absConfigPath
  };
}
function loggerOutput(title, msg, type = "info") {
  const tag = type === "info" ? colors.cyan(`[vite:mock]`) : colors.red(`[vite:mock-server]`);
  return console.log(
    `${colors.dim(( new Date()).toLocaleTimeString())} ${tag} ${colors.green(title)} ${colors.dim(
      msg
    )}`
  );
}

(async () => {
  try {
    await import('mockjs');
  } catch (e) {
    throw new Error("vite-plugin-vue-mock requires mockjs to be present in the dependency tree.");
  }
})();
const DIR_CLIENT = resolve(
  typeof __dirname !== "undefined" ? __dirname : dirname(
    fileURLToPath(import.meta.url)
  ),
  "../dist/inspect"
);
function viteMockServe(opt = {}) {
  let isDev = false;
  let config;
  return {
    name: "vite:mock",
    enforce: "pre",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
      isDev = config.command === "serve";
      isDev && createMockServer(opt, config);
    },
    configureServer: async ({ middlewares }) => {
      const { enable = isDev } = opt;
      if (!enable) {
        return;
      }
      const middleware = await requestMiddleware(opt);
      middlewares.use(middleware);
      middlewares.use("/__mockInspect/list", (req, res, next) => {
        res.end(
          JSON.stringify(
            mockData.map((i) => {
              return {
                ...i,
                exclude: excludeMock.has(`${i.url}+${i.method || "get"}`)
              };
            })
          )
        );
      });
      middlewares.use("/__mockInspect/exclude", (req, res, next) => {
        const isPost = req.method && req.method.toUpperCase() === "POST";
        if (isPost) {
          parseJson(req).then((body) => {
            if (body && body.urlList) {
              excludeMock.clear();
              body.urlList.forEach((url) => {
                excludeMock.add(url);
              });
              res.end(JSON.stringify({ code: 0 }));
            } else {
              next();
            }
          });
        } else {
          next();
        }
      });
      middlewares.use(
        "/__mockInspect",
        sirv(DIR_CLIENT, {
          single: true,
          dev: true
        })
      );
    }
  };
}

export { viteMockServe };
