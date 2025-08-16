const {
    HttpsProxyAgent
} = require('https-proxy-agent')
const zstd = require('node-zstandard');
const axios = require('axios').default
const electron = require('electron')
const express = require('express')
const fs = require('fs')
let gotScraping;

async function fetchWithGotScraping(url) {
    gotScraping ??= (await import('got-scraping')).gotScraping;

    return gotScraping.get({
        url: 'https://app.httptoolkit.tech' + url,
        headerGeneratorOptions: {
            browsers: [{
                name: 'chrome',
                minVersion: 87,
                maxVersion: 89
            }],
            devices: ['desktop'],
            locales: ['de-DE', 'en-US'],
            operatingSystems: ['windows', 'linux'],
        }
    })
};

function isZstdBuffer(data) {
    if (!Buffer.isBuffer(data) || data.length < 4) return false;
    const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
    return data.slice(0, 4).equals(magic);
}

function showPatchError(message) {
    console.error(message)
    electron.dialog.showErrorBox('Patch Error', message + '\n\nPlease report this issue on the GitHub repository (github.com/XielQs/httptoolkit-pro-patcher)')
}

const axiosInstance = axios.create({
    baseURL: 'https://app.httptoolkit.tech',
    httpsAgent: globalProxy ?
        new HttpsProxyAgent(
            globalProxy.startsWith('http') ?
            globalProxy.replace(/^http:/, 'https:') :
            'https://' + globalProxy
        ) :
        undefined //? Use proxy if set (globalProxy is injected by the patcher)
})

async function hasInternet() {
    return axiosInstance
        .head('/', {
            headers: {
                'Accept-Encoding': 'gzip, deflate, br',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) httptoolkit/1.19.1 Chrome/122.0.6261.130 Electron/29.1.5 Safari/537.36'
            }
        })
        .then(() => true)
        .catch((error) => {
            if (error.response && error.response.status === 429) {
                return true;
            }
            return false;
        });
}


const port = process.env.PORT || 5067
const tempPath = path.join(os.tmpdir(), 'httptoolkit-patch')

process.env.APP_URL = `http://localhost:${port}`
console.log(`[Patcher] Selected temp path: ${tempPath}`)

const app = express()

app.disable('x-powered-by')

app.all('*', async (req, res) => {
    console.log(`[Patcher] Request to: ${req.url}`)

    const requestURL = new URL(req.url, process.env.APP_URL).pathname

    let filePath = path.join(tempPath, requestURL === '/' ? 'index.html' : requestURL)

    if (['/view', '/intercept', '/settings', '/mock'].includes(requestURL)) {
        filePath += '.html'
    }

    //? Prevent loading service worker to avoid caching issues
    if (requestURL === '/ui-update-worker.js') {
        console.log(`[Patcher] Preventing service worker from loading`)
        res.header('Content-Type', 'application/javascript').send('self.addEventListener("install",e=>{e.waitUntil(self.skipWaiting()),console.log("[Patcher] HTTP Toolkit patched successfully =3")}),self.addEventListener("activate",e=>{e.waitUntil(self.clients.claim())}),self.addEventListener("fetch",()=>{});')
        return
    }

    if (!fs.existsSync(tempPath)) {
        console.log(`[Patcher] Temp path not found, creating: ${tempPath}`)
        fs.mkdirSync(tempPath)
    }

    if (!(await hasInternet())) {
        console.log(`[Patcher] No internet connection, trying to serve directly from temp path`)
        console.log(`[Patcher] File not found in temp path: ${filePath}`)
        const error = `No internet connection and file is not cached for file: ${requestURL}`
        res.status(200).send(path.extname(filePath) === '.js' ? `console.error(\`${error}\`);` : error)
        return
    }

    const HTTP_RETRY_MAX = 30 // -1 for infinite retry

    const reqHeaders = req.headers
    reqHeaders.host = 'app.httptoolkit.tech'
    reqHeaders.referer = 'https://app.httptoolkit.tech/'
    reqHeaders.origin = 'https://app.httptoolkit.tech'
    let retry = 0
    let status_code = 0

    try {
        console.log(`[Patcher] downloading File`)
        status_code = 0
        let remoteFile
        retry = 0
        while (status_code != 200 && (retry < HTTP_RETRY_MAX)) {
            try {
                if (retry > -1) {
                    retry = retry + 1
                }
                remoteFile = await axiosInstance.get(req.url, {
                    headers: reqHeaders,
                    responseType: 'arraybuffer'
                })
                status_code = remoteFile.status
            } catch (e) {
                status_code = 0
            }
        }
        if (status_code == 0) {
            console.log(`[Patcher] [ERR] Failed to fetch remote file: ${req.url}`)
            res.status(500).send('Internal server error')
            return
        }

        for (const [key, value] of Object.entries(remoteFile.headers)) res.setHeader(key, value)

        const recursiveMkdir = dir => {
            if (!fs.existsSync(dir)) {
                recursiveMkdir(path.dirname(dir))
                fs.mkdirSync(dir)
            }
        }

        recursiveMkdir(path.dirname(filePath))

        let data = remoteFile.data
        if (requestURL === '/main.js') { //? Patch main.js

            let compressed = 0
            if (isZstdBuffer(data) == 1) {
                fs.writeFileSync(filePath + ".comp", data)
                compressed = 1
                await new Promise((resolve, reject) => {
                    zstd.decompress(filePath + ".comp", filePath + ".decomp", (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                });
                fs.unlinkSync(filePath + ".comp");
                data = fs.readFileSync(filePath + ".decomp");
                fs.unlinkSync(filePath + ".decomp");
            }
            console.log(`[Patcher] Patching main.js`)
            res.setHeader('Cache-Control', 'no-store') //? Prevent caching

            data = data.toString()

            if (!data || data.length === 0) {
                const remoteFile = await fetchWithGotScraping(req.url);
                data = remoteFile.body

                if (isZstdBuffer(data) == 1) {
                    fs.writeFileSync(filePath + ".comp", data)
                    compressed = 1
                    await new Promise((resolve, reject) => {
                        zstd.decompress(filePath + ".comp", filePath + ".decomp", (err, result) => {
                            if (err) reject(err);
                            else resolve(result);
                        });
                    });
                    fs.unlinkSync(filePath + ".comp");
                    data = fs.readFileSync(filePath + ".decomp");
                    fs.unlinkSync(filePath + ".decomp");
                } else {
                    data = data.toString()
                }
                console.log("remoteFile", remoteFile.statusCode)
            }

            const accStoreName = data.match(/class ([0-9A-Za-z_$]+){constructor\(e\){this\.goToSettings=e/)?.[1]
            const modName = data.match(/([0-9A-Za-z_$]+).(getLatestUserData|getLastUserData)/)?.[1]

            if (!accStoreName) showPatchError(`[Patcher] [ERR] Account store name not found in main.js`)
            else if (!modName) showPatchError(`[Patcher] [ERR] Module name not found in main.js`)
            else {
                let patched = data
                    .replace(`class ${accStoreName}{`, `["getLatestUserData","getLastUserData"].forEach(p=>Object.defineProperty(${modName},p,{value:()=>user}));class ${accStoreName}{`)
                if (patched === data) showPatchError(`[Patcher] [ERR] Patch failed`)
                else {
                    patched = `const user=${JSON.stringify({
            email, //? Injected by the patcher
            featureFlags: [],
            subscription: {
              status: 'active',
              quanity: 1,
              expiry: new Date('9999-12-31').toISOString(),
              sku: 'pro-annual',
              plan: 'pro-annual',
              tierCode: 'pro',
              interval: 'annual',
              canManageSubscription: true,
              updateBillingDetailsUrl: 'https://github.com/XielQs/httptoolkit-pro-patcher',
            }
          })};user.subscription.expiry=new Date(user.subscription.expiry);` + patched
                    if (compressed == 1) {
                        fs.writeFileSync(filePath + ".decomp", patched)
                        await new Promise((resolve, reject) => {
                            zstd.compress(filePath + ".decomp", filePath + ".comp", 3, (err, result) => {
                                if (err) reject(err);
                                else resolve(result);
                            });
                        });
                        fs.unlinkSync(filePath + ".decomp");
                        data = fs.readFileSync(filePath + ".comp");
                        fs.unlinkSync(filePath + ".comp");
                    } else {
                        data = patched
                    }
                    console.log(`[Patcher] main.js patched`)
                }
            }
        }
        if (!data || data.length === 0) {
            console.error(`[Patcher] [ERR] Empty response for file: ${filePath}`, remoteFile)
            const error = `Empty response for file: ${requestURL}`
            res.status(200).send(path.extname(filePath) === '.js' ? `console.error(\`${error}\`);document.dispatchEvent(Object.assign(new Event('load:failed'),{error:new Error(\`${error}\`)}))` : error)
            return
        } else fs.writeFileSync(filePath, data)
        console.log(`[Patcher] File downloaded and saved: ${filePath}`)
        res.sendFile(filePath)
    } catch (e) {
        console.error(`[Patcher] [ERR] INTERNAL ERROR Failed to fetch remote file: ${filePath}`, e)
        res.status(500).send('Internal server error')
    }
})

app.listen(port, () => console.log(`[Patcher] Server listening on port ${port}`))

electron.app.on('ready', () => {
    //? Patching CORS headers to allow requests from localhost
    electron.session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        //* Blocking unwanted requests to prevent tracking
        const blockedHosts = ['events.httptoolkit.tech']
        if (blockedHosts.includes(new URL(details.url).hostname) || details.url.includes('sentry')) return callback({
            cancel: true
        })
        details.requestHeaders.Origin = 'https://app.httptoolkit.tech'
        callback({
            requestHeaders: details.requestHeaders
        })
    })
    electron.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        details.responseHeaders['Access-Control-Allow-Origin'] = [`http://localhost:${port}`]
        delete details.responseHeaders['access-control-allow-origin']
        callback({
            responseHeaders: details.responseHeaders
        })
    })
})

//? Disable caching for all requests
electron.app.commandLine.appendSwitch('disable-http-cache')
