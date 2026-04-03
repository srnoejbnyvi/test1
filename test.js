// ==UserScript==
// @name F-IFYBUJ - Auto Create & Upload
// @namespace http://tampermonkey.net/
// @version 9.00
// @description 函數化 + Setting面板 + 標題自動附加 + 偵錯
// @author You
// @match https://upload.e-hentai.org/manage
// @match https://upload.e-hentai.org/managefolders
// @match https://upload.e-hentai.org/managegallery*
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_deleteValue
// @grant GM_openInTab
// @grant GM_addValueChangeListener
// @grant GM_xmlhttpRequest
// @grant unsafeWindow
// @connect cdn.jsdelivr.net
// @connect unpkg.com
// @connect github.com
// @connect release-assets.githubusercontent.com
// @connect objects.githubusercontent.com
// @connect api.github.com
// @require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require https://cdn.jsdelivr.net/npm/kuroshiro@1.2.0/dist/kuroshiro.min.js
// @require https://cdn.jsdelivr.net/npm/kuroshiro-analyzer-kuromoji@1.1.0/dist/kuroshiro-analyzer-kuromoji.min.js
// @run-at document-end
// ==/UserScript==

(function() {
'use strict';

// ==================== Console 面板日誌 ====================
var _consoleLog = [];
var _consolePanel = null;

function _logToPanel(level, args) {
    var time = new Date().toLocaleTimeString();
    var msg = Array.prototype.slice.call(args).map(function(a) {
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
        return String(a);
    }).join(' ');
    _consoleLog.push({ time: time, level: level, msg: msg });
    if (_consolePanel && _consolePanel.addEntry) _consolePanel.addEntry(time, level, msg);
}

function _log() { if (currentSettings && currentSettings.logToBrowserConsole) { console.log.apply(console, arguments); } _logToPanel('INFO', arguments); }
function _error() { if (currentSettings && currentSettings.logToBrowserConsole) { console.error.apply(console, arguments); } _logToPanel('ERROR', arguments); }
function _warn() { if (currentSettings && currentSettings.logToBrowserConsole) { console.warn.apply(console, arguments); } _logToPanel('WARN', arguments); }

// ==================== 默認設置 ====================

function getDefaultSettings() {
return {
customRootFolder: '',
retryCount: 3,
translatedDefaultMTL: true,
nonJapaneseDefaultTranslated: false,
deleteDoubleConfirm: true,
doubleConfirmMs: 1000,
previewMaxWidth: 800,
previewMaxHeight: 800,
optionPriorities: {
mtl: 1,
digital: 2,
decensored: 3,
colorized: 4,
textless: 5,
sample: 6,
aiGenerated: 7,
ongoing: 8,
incomplete: 9
}
};
}

function loadSettings() {
try {
var saved = GM_getValue('fifybuj_settings', null);
if (saved) {
var defaults = getDefaultSettings();
return Object.assign({}, defaults, saved);
}
} catch(e) {
_log('[Settings] 載入失敗:', e.message);
}
return getDefaultSettings();
}

function saveSettings(settings) {
try {
GM_setValue('fifybuj_settings', settings);
_log('[Settings] 已保存');
} catch(e) {
_error('[Settings] 保存失敗:', e.message);
}
}

var currentSettings = loadSettings();

// ==================== Kuroshiro 初始化 ====================
var _kuroshiro = null;
var _kuroshiroReady = false;
var _kuroshiroInitPromise = null;

var KUROMOJI_DICT_FILES = [
    'base.dat.gz', 'check.dat.gz', 'tid.dat.gz',
    'tid_pos.dat.gz', 'tid_map.dat.gz', 'cc.dat.gz',
    'unk.dat.gz', 'unk_pos.dat.gz', 'unk_map.dat.gz',
    'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz'
];

var KUROMOJI_DICT_CDN = 'https://cdn.jsdelivr.net/gh/takuyaa/kuromoji.js@master/dict/';

function downloadDictFile(fileName, onProgress) {
    return new Promise(function(resolve, reject) {
        _log('[Dict] 下載:', fileName);
        GM_xmlhttpRequest({
            method: 'GET',
            url: KUROMOJI_DICT_CDN + fileName,
            responseType: 'arraybuffer',
            onload: function(resp) {
                if (resp.status >= 200 && resp.status < 300) {
                    _log('[Dict] 下載完成:', fileName, '大小:', resp.response.byteLength);
                    if (onProgress) onProgress(fileName);
                    resolve(resp.response);
                } else {
                    reject(new Error('[Dict] HTTP ' + resp.status + ': ' + fileName));
                }
            },
            onerror: function(err) {
                reject(new Error('[Dict] 下載失敗: ' + fileName + ' ' + (err.error || '')));
            },
            ontimeout: function() {
                reject(new Error('[Dict] 下載超時: ' + fileName));
            }
        });
    });
}

function saveDictToIDB(fileName, buffer) {
    return dbSet('dicts', fileName, buffer);
}

function loadDictFromIDB(fileName) {
    return dbGet('dicts', fileName);
}

function checkAllDictsInIDB() {
    return Promise.all(
        KUROMOJI_DICT_FILES.map(function(f) { return loadDictFromIDB(f); })
    ).then(function(results) {
        return results.every(function(r) { return r !== null && r !== undefined; });
    });
}

function buildBlobDictPath() {
    return Promise.all(
        KUROMOJI_DICT_FILES.map(function(fileName) {
            return loadDictFromIDB(fileName).then(function(buffer) {
                if (!buffer) throw new Error('字典文件不存在: ' + fileName);
                var blob = new Blob([buffer], { type: 'application/octet-stream' });
                var url = URL.createObjectURL(blob);
                return { fileName: fileName, url: url };
            });
        })
    ).then(function(entries) {
        var map = {};
        entries.forEach(function(e) { map[e.fileName] = e.url; });
        _log('[Dict] Blob URL 建立完成，共', entries.length, '個文件');
        return map;
    });
}

function initKuroshiro() {
    if (_kuroshiroInitPromise) return _kuroshiroInitPromise;
    _kuroshiroInitPromise = _initKuroshiroInternal();
    return _kuroshiroInitPromise;
}

function _initKuroshiroInternal() {
    _log('[Kuroshiro] 開始初始化...');
    _log('[Kuroshiro] typeof Kuroshiro:', typeof Kuroshiro);
    _log('[Kuroshiro] typeof KuromojiAnalyzer:', typeof KuromojiAnalyzer);

    var KuroshiroClass = (typeof Kuroshiro !== 'undefined') ? (Kuroshiro.default || Kuroshiro) : null;
    var AnalyzerClass = (typeof KuromojiAnalyzer !== 'undefined') ? (KuromojiAnalyzer.default || KuromojiAnalyzer) : null;

    if (!KuroshiroClass) {
        _error('[Kuroshiro] Kuroshiro 未定義');
        return Promise.resolve(false);
    }
    if (!AnalyzerClass) {
        _error('[Kuroshiro] KuromojiAnalyzer 未定義');
        return Promise.resolve(false);
    }

    return checkAllDictsInIDB().then(function(allCached) {
        if (allCached) {
            _log('[Kuroshiro] 字典已緩存，直接從 IndexedDB 載入');
            return Promise.resolve();
        }
        _log('[Kuroshiro] 字典未緩存，開始下載...');
        var downloaded = 0;
        var total = KUROMOJI_DICT_FILES.length;
        return KUROMOJI_DICT_FILES.reduce(function(chain, fileName) {
            return chain.then(function() {
                return downloadDictFile(fileName, function() {
                    downloaded++;
                    _log('[Dict] 進度:', downloaded + '/' + total, fileName);
                }).then(function(buffer) {
                    return saveDictToIDB(fileName, buffer);
                });
            });
        }, Promise.resolve());
    }).then(function() {
        return buildBlobDictPath();
    }).then(function(blobMap) {
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            var matched = false;
            KUROMOJI_DICT_FILES.forEach(function(f) {
                if (url && url.indexOf(f) !== -1 && blobMap[f]) {
                    url = blobMap[f];
                    matched = true;
                }
            });
            if (matched) _log('[Dict] XHR 攔截 →', url.substring(0, 50));
            this._intercepted = matched;
            return origOpen.call(this, method, url);
        };
        XMLHttpRequest.prototype.send = function() {
            return origSend.apply(this, arguments);
        };

        _kuroshiro = new KuroshiroClass();
        var analyzer = new AnalyzerClass({ dictPath: KUROMOJI_DICT_CDN });

        return _kuroshiro.init(analyzer).then(function() {
            XMLHttpRequest.prototype.open = origOpen;
            XMLHttpRequest.prototype.send = origSend;
            _kuroshiroReady = true;
            _log('[Kuroshiro] 初始化完成');
            KUROMOJI_DICT_FILES.forEach(function(f) {
                if (blobMap[f]) URL.revokeObjectURL(blobMap[f]);
            });
            return true;
        }).catch(function(err) {
            XMLHttpRequest.prototype.open = origOpen;
            XMLHttpRequest.prototype.send = origSend;
            _error('[Kuroshiro] init 失敗:', err.message || err);
            _kuroshiroInitPromise = null;
            return false;
        });
    }).catch(function(err) {
        _error('[Kuroshiro] 初始化例外:', err.message || err);
        _kuroshiroInitPromise = null;
        return false;
    });
}

// ==================== IndexedDB 工具函數 ====================

function openDB() {
return new Promise(function(resolve, reject) {
var req = indexedDB.open('FIFYBUJ_DB', 2);
req.onupgradeneeded = function(e) {
var db = e.target.result;
if (!db.objectStoreNames.contains('handles')) {
db.createObjectStore('handles', { keyPath: 'key' });
}
if (!db.objectStoreNames.contains('pending')) {
db.createObjectStore('pending', { keyPath: 'key' });
}
if (!db.objectStoreNames.contains('dicts')) {
db.createObjectStore('dicts', { keyPath: 'key' });
}
};
req.onsuccess = function(e) { resolve(e.target.result); };
req.onerror = function(e) { reject(e.target.error); };
});
}

function dbSet(storeName, key, value) {
return openDB().then(function(db) {
return new Promise(function(resolve, reject) {
var tx = db.transaction(storeName, 'readwrite');
var store = tx.objectStore(storeName);
var req = store.put({ key: key, value: value });
req.onsuccess = function() { resolve(); };
req.onerror = function(e) { reject(e.target.error); };
});
});
}

function dbGet(storeName, key) {
return openDB().then(function(db) {
return new Promise(function(resolve, reject) {
var tx = db.transaction(storeName, 'readonly');
var store = tx.objectStore(storeName);
var req = store.get(key);
req.onsuccess = function(e) { resolve(e.target.result ? e.target.result.value : null); };
req.onerror = function(e) { reject(e.target.error); };
});
});
}

function dbDelete(storeName, key) {
return openDB().then(function(db) {
return new Promise(function(resolve, reject) {
var tx = db.transaction(storeName, 'readwrite');
var store = tx.objectStore(storeName);
var req = store.delete(key);
req.onsuccess = function() { resolve(); };
req.onerror = function(e) { reject(e.target.error); };
});
});
}

// ==================== 自然排序工具 ====================

function naturalCompare(a, b) {
var ax = [], bx = [];
a.replace(/(\d+)|(\D+)/g, function(_, $1, $2) { ax.push([parseFloat($1) || Infinity, $2 || '']); });
b.replace(/(\d+)|(\D+)/g, function(_, $1, $2) { bx.push([parseFloat($1) || Infinity, $2 || '']); });
while (ax.length && bx.length) {
var an = ax.shift(), bn = bx.shift();
var nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
if (nn) return nn;
}
return ax.length - bx.length;
}

function lexicalCompare(a, b) {
return a < b ? -1 : a > b ? 1 : 0;
}

// ==================== 標題附加邏輯 ====================

function buildTitleSuffix(data) {
var mainSuffix = '';
var jpSuffix = '';
var mainPrefix = '';
var jpPrefix = '';

if (data.options && data.options.anthology) {
mainPrefix = '[Anthology] ';
jpPrefix = '[アンソロジー] ';
}

var langMap_official = {
'1058': { main: '[English]', jp: '[英語]' },
'3437': { main: '[Chinese]', jp: '[中国語]' },
'7017': { main: '[Korean]', jp: '[韓国語]' }
};
var langMap_translated = {
'1058': { main: '[English]', jp: '[英訳]' },
'3437': { main: '[Chinese]', jp: '[中国翻訳]' },
'7017': { main: '[Korean]', jp: '[韓国翻訳]' },
'8401': { main: '[French]', jp: '[フランス翻訳]' },
'11872': { main: '[German]', jp: '[ドイツ翻訳]' },
'5032': { main: '[Italian]', jp: '[イタリア翻訳]' },
'7769': { main: '[Portuguese-BR]', jp: '[ポルトガル翻訳]' },
'9314': { main: '[Russian]', jp: '[ロシア翻訳]' },
'6438': { main: '[Spanish]', jp: '[スペイン翻訳]' },
'8519': { main: '[Thai ภาษาไทย]', jp: '[タイ翻訳]' },
'12578': { main: '[Vietnamese Tiếng Việt]', jp: '[ベトナム翻訳]' }
};

var langTypeVal = data.langtype || '0';
var langId = data.language || '0';

if (langTypeVal === '0' || langTypeVal === '2') {
if (langMap_official[langId]) {
mainSuffix += ' ' + langMap_official[langId].main;
jpSuffix += ' ' + langMap_official[langId].jp;
}
}
if (langTypeVal === '1') {
if (langMap_translated[langId]) {
mainSuffix += ' ' + langMap_translated[langId].main;
jpSuffix += ' ' + langMap_translated[langId].jp;
}
}

var tags = [];
var priorities = currentSettings.optionPriorities || {};

if (data.mtl) tags.push({ priority: priorities.mtl || 1, main: '[MTL]', jp: '' });
if (data.options && data.options.digital) tags.push({ priority: priorities.digital || 2, main: '[Digital]', jp: '[DL版]' });
if (data.options && data.options.decensored) tags.push({ priority: priorities.decensored || 3, main: '[Decensored]', jp: '[無修正]' });
if (data.options && data.options.colorized) tags.push({ priority: priorities.colorized || 4, main: '[Colorized]', jp: '[カラー化]' });
if (data.options && data.options.textless) tags.push({ priority: priorities.textless || 5, main: '[Textless]', jp: '[無字]' });
if (data.options && data.options.sample) tags.push({ priority: priorities.sample || 6, main: '[Sample]', jp: '[見本]' });
if (data.options && data.options.aiGenerated) tags.push({ priority: priorities.aiGenerated || 7, main: '[AI Generated]', jp: '[AI生成]' });
if (data.options && data.options.ongoing) tags.push({ priority: priorities.ongoing || 8, main: '[Ongoing]', jp: '[進行中]' });
if (data.options && data.options.incomplete) tags.push({ priority: priorities.incomplete || 9, main: '[Incomplete]', jp: '[ページ欠落]' });

tags.sort(function(a, b) { return a.priority - b.priority; });
tags.forEach(function(tag) {
if (tag.main) mainSuffix += ' ' + tag.main;
if (tag.jp) jpSuffix += ' ' + tag.jp;
});

return { mainPrefix: mainPrefix, jpPrefix: jpPrefix, mainSuffix: mainSuffix, jpSuffix: jpSuffix };
}

// ==================== 文件驗證工具 ====================

var FILE_LIMITS = {
jpg: 20 * 1024 * 1024,
jpeg: 20 * 1024 * 1024,
webp: 20 * 1024 * 1024,
png: 50 * 1024 * 1024,
gif: 10 * 1024 * 1024
};
var ACCEPTED_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
var MAX_FILES = 2000;

function validateFile(name, size) {
var ext = name.split('.').pop().toLowerCase();
if (ACCEPTED_FORMATS.indexOf(ext) === -1) {
_log('[驗證] 過濾不支持格式:', name);
return false;
}
if (size !== undefined && FILE_LIMITS[ext] && size > FILE_LIMITS[ext]) {
_warn('[驗證] 文件超過大小限制:', name, '大小:', size, '限制:', FILE_LIMITS[ext]);
return false;
}
return true;
}

// ==================== handleManageGalleryPage ====================

function handleManageGalleryPage() {
if (!window.location.pathname.includes('/managegallery')) return;

_log('[AutoCreate] handleManageGalleryPage 開始, URL:', window.location.href);

var data = GM_getValue('pending_create', null);
var isFromQueue = false;
if (!data) {
var queue = GM_getValue('pending_create_queue', []);
if (queue.length > 0) {
data = queue.shift();
GM_setValue('pending_create_queue', queue);
isFromQueue = true;
_log('[AutoCreate] 從 queue 取得:', data ? data.id : 'null', '剩餘:', queue.length);
}
}
_log('[AutoCreate] pending_create:', data ? data.id : 'null');

if (!data) { _log('[AutoCreate] 無 pending_create，退出'); return; }
if (!isFromQueue) { GM_setValue('pending_create', null); }
_log('[AutoCreate] pending_create 已清除');

var filled = false;

function fillForm() {
if (filled) { _log('[AutoCreate] 已填過，跳過'); return; }

var gnameEn = document.getElementById('gname_en');
var saveBtn = document.getElementById('savebutton');

if (!gnameEn || !saveBtn) { _log('[AutoCreate] 表單元素尚未就緒，等待中...'); return; }

filled = true;
_log('[AutoCreate] 開始填表');

var titleParts = buildTitleSuffix(data);
var mainTitle = data.title1 || '';
var jpTitle = data.title2 || '';
if (mainTitle && !jpTitle) jpTitle = mainTitle;
else if (!mainTitle && jpTitle) mainTitle = jpTitle;

gnameEn.value = titleParts.mainPrefix + mainTitle + titleParts.mainSuffix;
gnameEn.dispatchEvent(new Event('input', { bubbles: true }));
_log('[AutoCreate] gname_en =', gnameEn.value);

var gnameJp = document.getElementById('gname_jp');
if (gnameJp) {
gnameJp.value = titleParts.jpPrefix + jpTitle + titleParts.jpSuffix;
_log('[AutoCreate] gname_jp =', gnameJp.value);
}

var categorySelect = document.getElementById('category');
if (categorySelect) {
Array.from(categorySelect.options).forEach(function(opt) {
if (opt.value === data.category) { opt.selected = true; _log('[AutoCreate] category =', opt.value, opt.text); }
});
}

var langSelect = document.getElementById('langtag');
if (langSelect) {
Array.from(langSelect.options).forEach(function(opt) {
if (opt.value === data.language) { opt.selected = true; _log('[AutoCreate] langtag =', opt.value, opt.text); }
});
langSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

var langTypeVal = data.langtype || '0';
var langTypeRadio = document.getElementById('langtype_' + langTypeVal);
if (langTypeRadio) { langTypeRadio.checked = true; langTypeRadio.dispatchEvent(new Event('change', { bubbles: true })); _log('[AutoCreate] langtype =', langTypeVal); }

var langCtl = document.getElementById('langctl');
if (langCtl && langTypeVal === '1') { langCtl.checked = !data.mtl; _log('[AutoCreate] langctl =', langCtl.checked); }

var folderSelect = document.getElementById('folderid');
if (folderSelect) {
var folderMatched = false;
Array.from(folderSelect.options).forEach(function(opt) {
if (opt.text.trim() === data.folder) { opt.selected = true; folderMatched = true; _log('[AutoCreate] folderid matched =', opt.value, opt.text); }
});
if (!folderMatched) {
var folderName = document.getElementById('foldername');
if (folderName && data.folder && data.folder !== 'Unsorted') { folderName.value = data.folder; _log('[AutoCreate] foldername =', folderName.value); }
}
}

var ulComment = document.getElementById('ulcomment');
if (ulComment) { ulComment.value = data.comment || ''; _log('[AutoCreate] ulcomment 已填入'); }

var tos = document.getElementById('tos');
if (tos && !tos.checked) { tos.click(); _log('[AutoCreate] tos 已點擊'); }
else if (tos) { _log('[AutoCreate] tos 已是勾選狀態'); }

if (typeof update_tosstate === 'function') { update_tosstate(); _log('[AutoCreate] update_tosstate 已調用'); }

var xhrDone = false;
var retryCount = 0;
var maxRetry = currentSettings.retryCount || 3;
var origOpen = XMLHttpRequest.prototype.open;
var origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url) { this._url = url; this._method = method; return origOpen.apply(this, arguments); };
XMLHttpRequest.prototype.send = function() {
var xhr = this;
xhr.addEventListener('load', function() {
_log('[AutoCreate] XHR load: status=', xhr.status, 'url=', xhr._url);
if (xhr.status >= 200 && xhr.status < 300 && !xhrDone) {
var doc = new DOMParser().parseFromString(xhr.responseText, 'text/html');
var dateAdded = Array.from(doc.querySelectorAll('td.k')).find(function(td) { return td.textContent.includes('Date Added'); });
var dateVal = dateAdded ? dateAdded.nextElementSibling : null;
_log('[AutoCreate] Date Added:', dateVal ? dateVal.textContent : 'N/A');
if (dateVal && dateVal.textContent && !dateVal.textContent.includes('Not created')) {
xhrDone = true;
XMLHttpRequest.prototype.open = origOpen;
XMLHttpRequest.prototype.send = origSend;
_log('[AutoCreate] 圖庫創建成功');
if (data.savedDataId) { GM_setValue('create_success', data.savedDataId); _log('[AutoCreate] create_success 已設置:', data.savedDataId); }
var ulgidMatch = xhr.responseURL ? xhr.responseURL.match(/ulgid=(\d+)/) : null;
if (!ulgidMatch) { var docUrl = doc.querySelector('a[href*="ulgid"]'); if (docUrl) ulgidMatch = docUrl.href.match(/ulgid=(\d+)/); }
if (ulgidMatch && data.savedDataId) {
var ulgid = ulgidMatch[1];
_log('[AutoCreate] 取得 ulgid:', ulgid, '準備儲存上傳任務');
var pendingUpload = { ulgid: ulgid, savedDataId: data.savedDataId };
GM_setValue('pending_upload', pendingUpload);
_log('[AutoCreate] pending_upload 已儲存，準備跳轉');
setTimeout(function() {
window.location.href = 'https://upload.e-hentai.org/managegallery?ulgid=' + ulgid;
}, 800);
} else {
_warn('[AutoCreate] 無法取得 ulgid，跳過上傳');
}
} else {
retryCount++;
_warn('[AutoCreate] 圖庫創建未確認，重試 ' + retryCount + '/' + maxRetry);
if (retryCount < maxRetry) {
setTimeout(function() { var sb = document.getElementById('savebutton'); if (sb && !sb.disabled) { sb.click(); _log('[AutoCreate] 重試點擊 savebutton'); } }, 2000);
}
}
}
});
return origSend.apply(this, arguments);
};

_log('[AutoCreate] 等待 savebutton 啟用...');
var saveBtnClicked = false;
var waitInterval = setInterval(function() {
var sb = document.getElementById('savebutton');
var tosEl = document.getElementById('tos');
var gnEl = document.getElementById('gname_en');
if (!sb) return;
_log('[AutoCreate] savebutton disabled =', sb.disabled, '| tos =', tosEl ? tosEl.checked : 'N/A', '| gname_en =', gnEl ? gnEl.value : 'N/A');
if (!sb.disabled && tosEl && tosEl.checked && gnEl && gnEl.value && !saveBtnClicked) {
saveBtnClicked = true;
clearInterval(waitInterval);
_log('[AutoCreate] savebutton 已啟用，點擊中...');
sb.click();
sb.disabled = true;
_log('[AutoCreate] savebutton 已點擊');
}
}, 300);
}

var checkInterval = setInterval(function() { if (document.getElementById('gname_en')) { clearInterval(checkInterval); fillForm(); } }, 100);
setTimeout(function() { clearInterval(checkInterval); if (!filled) { _log('[AutoCreate] 超時，強制執行 fillForm'); fillForm(); } }, 5000);
}

// ==================== startFolderUpload ====================

function startFolderUpload(savedDataId) {
_log('[Upload] startFolderUpload 開始, savedDataId:', savedDataId);
var fileListEntry = null;
try {
var fileLists = GM_getValue('file_lists', {});
fileListEntry = fileLists[savedDataId] || null;
} catch(e) { _error('[Upload] 讀取 file_lists 失敗:', e); return; }

if (!fileListEntry || !fileListEntry.files || fileListEntry.files.length === 0) {
_warn('[Upload] 無文件列表，跳過上傳, savedDataId:', savedDataId);
return;
}

var folderName = fileListEntry.folderName || null;
var files = fileListEntry.files;
_log('[Upload] folderName:', folderName, '文件數:', files.length);

if (!folderName) {
_warn('[Upload] 無 folderName，無法解析路徑，跳過上傳');
return;
}

dbGet('handles', 'root_folder_handle').then(function(rootHandle) {
if (!rootHandle) { _error('[Upload] 無 root_folder_handle，請在 Setting 中設定根目錄'); return; }
_log('[Upload] 取得 root_folder_handle，進入子資料夾:', folderName);
return rootHandle.requestPermission({ mode: 'read' }).then(function(perm) {
if (perm !== 'granted') { _error('[Upload] 根目錄無讀取權限'); return; }
return rootHandle.getDirectoryHandle(folderName).then(function(folderHandle) {
_log('[Upload] 成功取得資料夾 handle:', folderName);
var filePromises = files.map(function(fileEntry) {
var parts = (fileEntry.path || fileEntry.name || '').split('/');
function resolveHandle(handle, parts) {
if (parts.length === 1) {
return handle.getFileHandle(parts[0]).then(function(fh) { return fh.getFile(); });
}
return handle.getDirectoryHandle(parts[0]).then(function(dh) {
return resolveHandle(dh, parts.slice(1));
});
}
return resolveHandle(folderHandle, parts).catch(function(err) {
_warn('[Upload] 無法解析檔案:', fileEntry.path, err.message);
return null;
});
});
return Promise.all(filePromises).then(function(fileObjs) {
fileObjs = fileObjs.filter(function(f) { return f !== null; });
_log('[Upload] 成功解析', fileObjs.length, '個 File 物件');
if (fileObjs.length === 0) { _warn('[Upload] 無有效 File 物件，跳過上傳'); return; }
function waitForMultiUploadBtn(retries) {
if (retries <= 0) { _error('[Upload] Multi Upload 按鈕等待超時'); return; }
var btn = Array.from(document.querySelectorAll('button')).find(function(b) {
return b.textContent.trim() === 'Multi Upload';
});
if (!btn) {
_log('[Upload] 等待 Multi Upload 按鈕...');
setTimeout(function() { waitForMultiUploadBtn(retries - 1); }, 500);
return;
}
var parent = btn.parentElement;
var hiddenInput = parent ? Array.from(parent.querySelectorAll('input[type="file"]')).find(function(i) {
return i.style.display === 'none' && i.multiple;
}) : null;
if (!hiddenInput) {
_log('[Upload] 等待 hiddenInput...');
setTimeout(function() { waitForMultiUploadBtn(retries - 1); }, 500);
return;
}
_log('[Upload] 找到 Multi Upload hiddenInput，注入', fileObjs.length, '個檔案');
var dt = new DataTransfer();
fileObjs.forEach(function(f) { dt.items.add(f); });
hiddenInput.files = dt.files;
hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
_log('[Upload] change 事件已觸發，上傳腳本接管');
}
waitForMultiUploadBtn(20);
});
}).catch(function(err) {
_error('[Upload] 無法取得資料夾 handle:', folderName, err.message);
});
});
}).catch(function(err) {
_error('[Upload] startFolderUpload 失敗:', err);
});
}

// ==================== UI 工具函數 ====================

function getStoredFolders() {
  try { var v = GM_getValue('scanned_folders', []); return Array.isArray(v) ? v : []; } catch(e) { return []; }
}

function applySelectStyle(select, width) {
width = width || '100px';
select.style.cssText =
'width: ' + width + ' !important;' +
'height: 20px !important;' +
'min-height: 20px !important;' +
'max-height: 20px !important;' +
'padding: 0 2px !important;' +
'margin: 0 !important;' +
'border: 1px solid #5C0D12 !important;' +
'background-color: #E0DED3 !important;' +
'font-size: 9pt !important;' +
'line-height: 18px !important;' +
'box-sizing: border-box !important;';
}

function createPlainCheckbox(label, groupName, isIndependent) {
var container = document.createElement('span');
container.style.cssText = 'display: inline-flex !important; align-items: center !important; white-space: nowrap !important; margin-right: 4px !important;';
var cb = document.createElement('input');
cb.type = 'checkbox';
if (!isIndependent) cb.name = groupName;
cb.style.cssText = 'margin: 0 2px 0 0 !important; position: relative !important; top: 0px !important; background-color: #E0DED3 !important; accent-color: #5C0D12 !important;';
container.appendChild(cb);
container.appendChild(document.createTextNode(label));
return { container: container, checkbox: cb };
}

function createLangSelect() {
var select = document.createElement('select');
applySelectStyle(select, '140px');
var groups = [
{ label: 'Common', options: [
['0', 'Japanese / No Text'], ['3437', 'Chinese'], ['1058', 'English'],
['8401', 'French'], ['5032', 'Italian'], ['7017', 'Korean'],
['7769', 'Portuguese'], ['9314', 'Russian'], ['6438', 'Spanish']
]},
{ label: 'Textless', options: [['321846', 'Speechless'], ['321847', 'Text Cleaned']]},
{ label: 'Others', options: [
['331300', 'Albanian'], ['76810', 'Arabic'], ['357697', 'Bengali'],
['452282', 'Bulgarian'], ['456692', 'Burmese'], ['156343', 'Catalan'],
['420982', 'Cebuano'], ['293389', 'Croatian'], ['47394', 'Czech'],
['17351', 'Danish'], ['15466', 'Dutch'], ['344972', 'Esperanto'],
['29699', 'Finnish'], ['11872', 'German'], ['51068', 'Greek'],
['344855', 'Hebrew'], ['131030', 'Hindi'], ['41679', 'Hungarian'],
['10133', 'Indonesian'], ['468974', 'Javanese'], ['363067', 'Latin'],
['35957', 'Norwegian'], ['394366', 'Persian'], ['8300', 'Polish'],
['81413', 'Romanian'], ['385309', 'Serbian'], ['346949', 'Slovak'],
['32335', 'Swedish'], ['14282', 'Tagalog'], ['8519', 'Thai'],
['30977', 'Turkish'], ['289965', 'Ukrainian'], ['12578', 'Vietnamese']
]}
];
groups.forEach(function(group) {
var optgroup = document.createElement('optgroup');
optgroup.label = group.label;
group.options.forEach(function(pair) {
var option = document.createElement('option');
option.value = pair[0];
option.textContent = pair[1];
if (pair[0] === '0') option.selected = true;
optgroup.appendChild(option);
});
select.appendChild(optgroup);
});
return select;
}

function createCategorySelect(selectedCat) {
var select = document.createElement('select');
applySelectStyle(select, '100px');
var categories = ['Doujinshi', 'Manga', 'Artist CG', 'Game CG', 'Non-H', 'Image Set', 'Western', 'Cosplay', 'Misc'];
categories.forEach(function(cat) {
var option = document.createElement('option');
option.value = cat;
option.textContent = cat;
if (cat === selectedCat) option.selected = true;
select.appendChild(option);
});
return select;
}

function getLocalFolders() {
  try { var v = GM_getValue('local_folders', ['Waiting Create']); return Array.isArray(v) ? v : ['Waiting Create']; } catch(e) { return ['Waiting Create']; }
}

function saveLocalFolders(folders) {
try { GM_setValue('local_folders', folders); } catch(e) { _error('[LocalFolder] 保存失敗:', e); }
}

function createFolderSelect() {
var select = document.createElement('select');
applySelectStyle(select, '155px');
var defaultOption = document.createElement('option');
defaultOption.value = 'Unsorted';
defaultOption.textContent = 'Unsorted';
defaultOption.selected = true;
select.appendChild(defaultOption);
var folders = getStoredFolders();
  folders.forEach(function(folder) {
  var option = document.createElement('option');
  option.value = folder;
  option.textContent = folder;
  select.appendChild(option);
  });
  var separator = document.createElement('option');
  separator.value = '';
  separator.textContent = '-----Local Folder-----';
  separator.disabled = true;
  separator.style.cssText = 'font-weight: bold; color: #5C0D12;';
  select.appendChild(separator);
  var localFolders = getLocalFolders();
  localFolders.forEach(function(folder) {
var option = document.createElement('option');
option.value = 'local:' + folder;
option.textContent = folder;
select.appendChild(option);
});
return select;
}

function createGoBtn() {
var btn = document.createElement('button');
btn.textContent = 'GO';
btn.style.cssText =
'background-color: #E0DED3;' +
'border: 1px solid #5C0D12;' +
'color: #5C0D12;' +
'font-weight: bold;' +
'font-size: 9pt;' +
'padding: 2px 8px;' +
'cursor: pointer;' +
'border-radius: 3px;' +
'white-space: nowrap;' +
'height: 20px;' +
'line-height: 18px;' +
'box-sizing: border-box;' +
'vertical-align: middle;';
return btn;
}

function getFilesTextCenter() {
var th = document.querySelector('.s[data-custom="true"] th.h3');
if (!th) return null;
var range = document.createRange();
range.selectNodeContents(th);
var textRect = range.getBoundingClientRect();
return (textRect.left + textRect.right) / 2;
}

function alignSwapBtn(btns, td) {
var textCenter = getFilesTextCenter();
if (textCenter === null) return;
var tdRect = td.getBoundingClientRect();
if (!Array.isArray(btns)) btns = [btns];
btns.forEach(function(btn) {
var btnWidth = btn.getBoundingClientRect().width;
btn.style.marginLeft = (textCenter - tdRect.left - btnWidth / 2) + 'px';
btn.style.marginRight = '0';
});
}

function alignFilesText(textEl, td) {
var textCenter = getFilesTextCenter();
if (textCenter === null) return;
var tdRect = td.getBoundingClientRect();
var textWidth = textEl.getBoundingClientRect().width;
textEl.style.position = 'absolute';
textEl.style.left = (textCenter - tdRect.left - textWidth / 2) + 'px';
textEl.style.top = '50%';
textEl.style.transform = 'translateY(-50%)';
textEl.style.margin = '0';
}

// ==================== 頂層函數：applyToChecked ====================

function applyToChecked(tbody, callback) {
var allTrs = tbody.querySelectorAll('tr:not(.gtr)');
var groups = [];
var currentGroup = [];
allTrs.forEach(function(tr) {
currentGroup.push(tr);
if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; }
});
groups.forEach(function(group) {
var tr1 = group[0];
var cb = tr1.querySelector('td.gtc6 input[type="checkbox"]');
if (cb && cb.checked) { callback(tr1, group); }
});
}

// ==================== 頂層函數：allSaveChecked ====================

function allSaveChecked(tbody, folderRow1) {
var allTrs = tbody.querySelectorAll('tr:not(.gtr)');
var groups = [];
var currentGroup = [];
allTrs.forEach(function(tr) {
currentGroup.push(tr);
if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; }
});
groups.forEach(function(group) {
var tr1 = group[0];
var tr2 = group[1];
var cb = tr1.querySelector('td.gtc6 input[type="checkbox"]');
if (!cb || !cb.checked) return;

var titleInput = tr1.querySelector('td.gtc1 input');
var filesText = tr1.querySelector('td.gtc3');
var selects = tr1.querySelectorAll('td.gtc4 select');
var title2Input = tr2.querySelector('td.gtc1 input');
var checkboxes = tr2.querySelectorAll('td.gtc-options input[type="checkbox"]');
var commentTA = tr2.querySelector('td.gtc-options textarea.uploader-comment-ta');
var existingId = tr2.dataset.savedDataId || null;

var galleryData = {
id: existingId || (Date.now() + '_' + (titleInput ? titleInput.value : '')),
title1: titleInput ? titleInput.value : '',
title2: title2Input ? title2Input.value : '',
files: filesText ? filesText.textContent : 'N/A',
category: selects[0] ? selects[0].value : 'Doujinshi',
language: selects[1] ? selects[1].value : '0',
folder: selects[2] ? selects[2].value : 'Unsorted',
options: {
    official: checkboxes[1] ? checkboxes[1].checked : false,
    translated: checkboxes[4] ? checkboxes[4].checked : false,
    rewrite: checkboxes[7] ? checkboxes[7].checked : false,
    digital: checkboxes[10] ? checkboxes[10].checked : false,
    decensored: checkboxes[5] ? checkboxes[5].checked : false,
    aiGenerated: checkboxes[2] ? checkboxes[2].checked : false,
    colorized: checkboxes[8] ? checkboxes[8].checked : false,
    textless: false,
    incomplete: checkboxes[6] ? checkboxes[6].checked : false,
    sample: checkboxes[11] ? checkboxes[11].checked : false,
    anthology: checkboxes[3] ? checkboxes[3].checked : false,
    ongoing: checkboxes[9] ? checkboxes[9].checked : false
},
mtl: checkboxes[0] ? checkboxes[0].checked : false,
comment: commentTA ? commentTA.value : '',
timestamp: Date.now()
};

try {
var existingGalleries = GM_getValue('saved_galleries', []);
if (existingId) { existingGalleries = existingGalleries.filter(function(g) { return g.id !== existingId; }); }
existingGalleries.push(galleryData);
GM_setValue('saved_galleries', existingGalleries);
tr2.dataset.savedDataId = galleryData.id;
} catch(err) { _error('allSave error:', err); }
});
}

// ==================== 頂層函數：allCreateChecked ====================

function allCreateChecked(tbody) {
var allTrs = tbody.querySelectorAll('tr:not(.gtr)');
var groups = [];
var currentGroup = [];
allTrs.forEach(function(tr) {
currentGroup.push(tr);
if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; }
});
var pendingQueue = [];
groups.forEach(function(group) {
var tr1 = group[0];
var tr2 = group[1];
var cb = tr1.querySelector('td.gtc6 input[type="checkbox"]');
if (!cb || !cb.checked) return;

var titleInput = tr1.querySelector('td.gtc1 input');
var filesText = tr1.querySelector('td.gtc3');
var selects = tr1.querySelectorAll('td.gtc4 select');
var title2Input = tr2.querySelector('td.gtc1 input');
var checkboxes = tr2.querySelectorAll('td.gtc-options input[type="checkbox"]');
var commentTA = tr2.querySelector('td.gtc-options textarea.uploader-comment-ta');

var categoryMap = { 'Doujinshi': '2', 'Manga': '3', 'Artist CG': '4', 'Game CG': '5', 'Western': '10', 'Non-H': '9', 'Image Set': '6', 'Cosplay': '7', 'Misc': '1' };
var langTypeVal = '0';
if (checkboxes[4] && checkboxes[4].checked) langTypeVal = '1';
else if (checkboxes[7] && checkboxes[7].checked) langTypeVal = '2';

var catVal = selects[0] ? selects[0].value : 'Doujinshi';
var pendingData = {
id: Date.now() + '_' + (titleInput ? titleInput.value : ''),
title1: titleInput ? titleInput.value : '',
title2: title2Input ? title2Input.value : '',
files: filesText ? filesText.textContent : 'N/A',
category: categoryMap[catVal] || '2',
categoryText: catVal,
language: selects[1] ? selects[1].value : '0',
folder: selects[2] ? selects[2].value : 'Unsorted',
langtype: langTypeVal,
mtl: checkboxes[0] ? checkboxes[0].checked : false,
comment: commentTA ? commentTA.value : '',
savedDataId: tr2.dataset.savedDataId || null,
options: {
    official: checkboxes[1] ? checkboxes[1].checked : false,
    translated: checkboxes[4] ? checkboxes[4].checked : false,
    rewrite: checkboxes[7] ? checkboxes[7].checked : false,
    digital: checkboxes[10] ? checkboxes[10].checked : false,
    decensored: checkboxes[5] ? checkboxes[5].checked : false,
    aiGenerated: checkboxes[2] ? checkboxes[2].checked : false,
    colorized: checkboxes[8] ? checkboxes[8].checked : false,
    textless: false,
    incomplete: checkboxes[6] ? checkboxes[6].checked : false,
    sample: checkboxes[11] ? checkboxes[11].checked : false,
    anthology: checkboxes[3] ? checkboxes[3].checked : false,
    ongoing: checkboxes[9] ? checkboxes[9].checked : false
}
};
pendingQueue.push(pendingData);
});

if (pendingQueue.length > 0) {
GM_setValue('pending_create_queue', pendingQueue);
pendingQueue.forEach(function() { GM_openInTab('https://upload.e-hentai.org/managegallery?act=new', { active: false }); });
}
}

// ==================== 頂層函數：allDeleteChecked ====================

function allDeleteChecked(tbody, folderRow1, waitingCreateCountRef) {
var allTrs = tbody.querySelectorAll('tr:not(.gtr)');
var groups = [];
var currentGroup = [];
allTrs.forEach(function(tr) {
currentGroup.push(tr);
if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; }
});
var toDelete = [];
groups.forEach(function(group) {
var tr1 = group[0];
var cb = tr1.querySelector('td.gtc6 input[type="checkbox"]');
if (cb && cb.checked) toDelete.push(group);
});
toDelete.forEach(function(group) {
var tr2 = group[1];
var sid = tr2.dataset.savedDataId;
group.forEach(function(tr) { tr.remove(); });
waitingCreateCountRef.value--;
if (sid) {
try {
var existingGalleries = GM_getValue('saved_galleries', []);
GM_setValue('saved_galleries', existingGalleries.filter(function(g) { return g.id !== sid; }));
var fileList = GM_getValue('file_lists', {});
delete fileList[sid];
GM_setValue('file_lists', fileList);
} catch(err) { _error('allDelete save error:', err); }
}
});
var folderStrong1 = folderRow1.querySelector('strong');
if (folderStrong1) folderStrong1.textContent = Math.max(0, waitingCreateCountRef.value);
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
}

// ==================== 頂層函數：fixAllGroups ====================

function fixAllGroups(sectionDiv, folderRow1) {
var firstRow = sectionDiv.querySelector('tbody tr:not(.gtr)');
if (!firstRow) return;
sectionDiv.querySelectorAll('td.gtc3').forEach(function(td) {
var btns = Array.from(td.querySelectorAll('button'));
if (btns.length > 0) alignSwapBtn(btns, td);
});
sectionDiv.querySelectorAll('td.gtc3 span.files-text').forEach(function(span) { var td = span.closest('td'); if (td) alignFilesText(span, td); });
}

// ==================== Romanization 規則引擎 ====================

var HONORIFICS = ['chan', 'kun', 'san', 'sama', 'dono', 'senpai', 'kouhai', 'sensei'];

function preprocessLoanwords(text) {

    var dicts = GM_getValue('user_dicts', {});
    var compound = dicts.compound || {};
    var proper = dicts.proper || {};
    var loan = dicts.loanwords || {};

    var allLocalDicts = [compound, proper, loan];
    allLocalDicts.forEach(function(dict) {
        var keys = Object.keys(dict).sort(function(a, b) { return b.length - a.length; });
        keys.forEach(function(jp) {
            text = text.split(jp).join(' ' + dict[jp] + ' ');
        });
    });

    text = text.replace(/\s*&\s*/g, ' & ');
    text = text.replace(/×/g, ' x ');
    text = text.replace(/～/g, ' ~ ');
    text = text.replace(/（/g, '(');
    text = text.replace(/）/g, ')');
    text = text.replace(/　/g, ' ');
    text = text.replace(/！/g, '!');
    text = text.replace(/？/g, '?');
    text = text.replace(/・/g, '-');
    text = text.replace(/、/g, ',');
    text = text.replace(/。/g, '.');
    text = text.replace(/([A-Za-z])([　-鿿豈-﫿])/g, '$1 $2');
    text = text.replace(/\s+/g, ' ').trim();

    return dbGet('dicts', 'jmdict_data').then(function(jmdictData) {
        if (jmdictData && Array.isArray(jmdictData)) {
            jmdictData.forEach(function(entry) {
                if (!entry.expression || !entry.glossary || entry.glossary.length === 0) return;
                if (entry.expression.length === 1) return;
                var isKatakana = /^[ァ-ヿー]+$/.test(entry.expression);
                if (!isKatakana) return;
                if (text.indexOf(entry.expression) === -1) return;
                var bestGlossary = null;
                var minLength = Infinity;
                entry.glossary.forEach(function(g) {
                    var clean = g.replace(/（★）/g, '').replace(/（🅁）/g, '').replace(/★/g, '').replace(/🅁/g, '').trim();
                    if (/^[A-Za-z]+$/.test(clean) && clean.length < minLength && clean.length <= entry.expression.length * 2) {
                        bestGlossary = clean;
                        minLength = clean.length;
                    }
                });
                if (bestGlossary) {
                    text = text.split(entry.expression).join(' ' + bestGlossary + ' ');
                }
            });
        }
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    }).catch(function() {
        return text;
    });
}

function kanaToRomaji(kana) {
    var map = {
        'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o',
        'カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
        'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
        'タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
        'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
        'ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
        'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
        'ヤ':'ya','ユ':'yu','ヨ':'yo',
        'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro',
        'ワ':'wa','ヲ':'o','ン':'n',
        'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
        'ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
        'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do',
        'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
        'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po',
        'キャ':'kya','キュ':'kyu','キョ':'kyo',
        'シャ':'sha','シュ':'shu','ショ':'sho',
        'チャ':'cha','チュ':'chu','チョ':'cho',
        'ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
        'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo',
        'ミャ':'mya','ミュ':'myu','ミョ':'myo',
        'リャ':'rya','リュ':'ryu','リョ':'ryo',
        'ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
        'ジャ':'ja','ジュ':'ju','ジョ':'jo',
        'ビャ':'bya','ビュ':'byu','ビョ':'byo',
        'ピャ':'pya','ピュ':'pyu','ピョ':'pyo',
        'ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo',
        'ティ':'ti','ディ':'di','デュ':'dyu',
        'ウィ':'wi','ウェ':'we','ウォ':'wo',
        'ヴァ':'va','ヴィ':'vi','ヴ':'vu','ヴェ':'ve','ヴォ':'vo',
        'ツァ':'tsa','ツィ':'tsi','ツェ':'tse','ツォ':'tso',
        'あ':'a','い':'i','う':'u','え':'e','お':'o',
        'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
        'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
        'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
        'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
        'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
        'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
        'や':'ya','ゆ':'yu','よ':'yo',
        'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
        'わ':'wa','を':'o','ん':'n',
        'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
        'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
        'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
        'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
        'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
        'きゃ':'kya','きゅ':'kyu','きょ':'kyo',
        'しゃ':'sha','しゅ':'shu','しょ':'sho',
        'ちゃ':'cha','ちゅ':'chu','ちょ':'cho',
        'にゃ':'nya','にゅ':'nyu','にょ':'nyo',
        'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo',
        'みゃ':'mya','みゅ':'myu','みょ':'myo',
        'りゃ':'rya','りゅ':'ryu','りょ':'ryo',
        'ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
        'じゃ':'ja','じゅ':'ju','じょ':'jo',
        'びゃ':'bya','びゅ':'byu','びょ':'byo',
        'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo'
    };
    var result = '';
    var i = 0;
    while (i < kana.length) {
        // 促音（っ/ッ）
        if (kana[i] === 'っ' || kana[i] === 'ッ') {
            var next2 = kana.substring(i + 1, i + 3);
            var next1 = kana.substring(i + 1, i + 2);
            var nextRomaji = map[next2] || map[next1] || '';
            if (nextRomaji) {
                result += nextRomaji[0];
            }
            i++;
            continue;
        }
        // 長音符（ー）
        if (kana[i] === 'ー') {
            if (result.length > 0) {
                var lastVowel = result[result.length - 1];
                var vowelMap = { 'a': 'a', 'i': 'i', 'u': 'u', 'e': 'e', 'o': 'u' };
                result += (vowelMap[lastVowel] || lastVowel);
            }
            i++;
            continue;
        }
        // 先嘗試兩字元組合
        var two = kana.substring(i, i + 2);
        if (map[two]) {
            result += map[two];
            i += 2;
            continue;
        }
        // 再嘗試單字元
        var one = kana[i];
        if (map[one]) {
            result += map[one];
            i++;
            continue;
        }
        // 無法映射，保留原字元
        result += one;
        i++;
    }
    return result;
}

function processTokens(tokens) {
    var PARTICLES = {
        'が':'ga','の':'no','を':'o','は':'wa','に':'ni','へ':'e',
        'と':'to','も':'mo','か':'ka','や':'ya','な':'na','で':'de',
        'から':'kara','まで':'made','より':'yori','など':'nado',
        'ね':'ne','よ':'yo','わ':'wa','ぞ':'zo','ぜ':'ze'
    };

    function readingToHiragana(str) {
        return str.replace(/[ァ-ン]/g, function(c) {
            return String.fromCharCode(c.charCodeAt(0) - 0x60);
        });
    }

    function lookupReading(index, reading) {
        if (!index || !reading) return null;
        var results = index[reading] || index[readingToHiragana(reading)] || null;
        return results && results.length > 0 ? results[0] : null;
    }

    function getBestEnglish(entry) {
        if (!entry || !entry.glossary) return null;
        var best = null;
        var minLen = Infinity;
        entry.glossary.forEach(function(g) {
            var clean = g.replace(/（★）|（🅁）|★|🅁/g, '').trim();
            if (/^[A-Za-z][A-Za-z\s\-]*$/.test(clean) && clean.length < minLen && clean.length <= 30) {
                best = clean;
                minLen = clean.length;
            }
        });
        return best;
    }

    function isNounToken(token) {
        var pos = token.pos || '';
        var detail = token.pos_detail_1 || '';
        return pos === '名詞' && detail !== '接尾' && detail !== '非自立' && detail !== '数';
    }

    function greedyMerge(tokens, startIdx, index) {
        var maxLook = Math.min(5, tokens.length - startIdx);
        for (var len = maxLook; len >= 2; len--) {
            var mergedReading = '';
            var valid = true;
            for (var k = 0; k < len; k++) {
                var t = tokens[startIdx + k];
                var tPos = t.pos || '';
                var tDetail = t.pos_detail_1 || '';
                var tSurface = t.surface_form || t.surface || '';
                if (/^[A-Za-z0-9]+$/.test(tSurface)) { valid = false; break; }
                if (tPos === '助詞' || tPos === '助動詞') { valid = false; break; }
                mergedReading += (t.reading || tSurface);
            }
            if (!valid || !mergedReading) continue;
            var entry = lookupReading(index, mergedReading);
            if (entry) {
                var english = getBestEnglish(entry);
                if (english) return { count: len, romaji: english, isEnglish: true };
                var romaji = kanaToRomaji(mergedReading);
                if (romaji) return { count: len, romaji: romaji, isEnglish: false };
            }
        }
        return null;
    }

    return dbGet('dicts', 'jmdict_reading_index').then(function(index) {
        var result = [];
        var i = 0;

        while (i < tokens.length) {
            var token = tokens[i];
            var surface = token.surface_form || token.surface || '';
            var reading = token.reading || surface;
            var pos = token.pos || '';
            var pos_detail_1 = token.pos_detail_1 || '';

            // 記号（空白）→ 空格
            if (pos === '記号' && pos_detail_1 === '空白') {
                result.push(' ');
                i++;
                continue;
            }

            // 記号（其他）→ 保留原樣
            if (pos === '記号') {
                result.push(surface);
                i++;
                continue;
            }

            // 英文/數字 → 保留原樣
            if (/^[A-Za-z0-9]+$/.test(surface)) {
                if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                result.push(surface);
                i++;
                continue;
            }

            // 助詞 → 小寫，獨立詞
            if (pos === '助詞') {
                var particleRomaji = PARTICLES[surface] || kanaToRomaji(reading).toLowerCase();
                if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                result.push(particleRomaji);
                result.push(' ');
                i++;
                continue;
            }

            // 接頭詞 → 與下一個 token 合併
            if (pos === '接頭詞' || pos === '接頭語') {
                var prefixRomaji = kanaToRomaji(reading);
                var combined = prefixRomaji;
                i++;
                if (i < tokens.length) {
                    var nextToken = tokens[i];
                    var nextSurface = nextToken.surface_form || nextToken.surface || '';
                    var nextReading = nextToken.reading || nextSurface;
                    combined += /^[A-Za-z0-9]+$/.test(nextSurface) ? nextSurface : kanaToRomaji(nextReading);
                    i++;
                }
                if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                result.push(combined.charAt(0).toUpperCase() + combined.slice(1));
                continue;
            }

            // 助動詞・接尾 → 與前一個詞合併
            if (pos === '助動詞' || pos_detail_1 === '接尾') {
                var auxRomaji = kanaToRomaji(reading);
                while (result.length > 0 && result[result.length - 1] === ' ') result.pop();
                result.push(auxRomaji);
                i++;
                continue;
            }

            // 名詞 → 先嘗試貪婪合併
            if (isNounToken(token)) {
                var merged = greedyMerge(tokens, i, index);
                if (merged) {
                    if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                    var cap = merged.isEnglish
                        ? merged.romaji.charAt(0).toUpperCase() + merged.romaji.slice(1)
                        : merged.romaji.charAt(0).toUpperCase() + merged.romaji.slice(1);
                    result.push(cap);
                    i += merged.count;
                    continue;
                }
            }

            // 一般轉換
            var romaji = kanaToRomaji(reading);
            romaji = romaji.replace(/tch/gi, 'cch');
            if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
            result.push(romaji.charAt(0).toUpperCase() + romaji.slice(1));
            i++;
        }

        var output = result.join('');
        output = output.replace(/\s+/g, ' ').trim();
        output = output.replace(/\(\s+/g, '(');
        output = output.replace(/\s+\)/g, ')');
        output = output.replace(/\[\s+/g, '[');
        output = output.replace(/\s+\]/g, ']');
        return output;
    });
}

function applyRomajiRules(romaji) {
    // 規則 4: 移除長音符號
    var macronMap = { 'ā': 'aa', 'ē': 'ee', 'ī': 'ii', 'ō': 'ou', 'ū': 'uu',
                      'Ā': 'Aa', 'Ē': 'Ee', 'Ī': 'Ii', 'Ō': 'Ou', 'Ū': 'Uu' };
    romaji = romaji.replace(/[āēīōūĀĒĪŌŪ]/g, function(c) { return macronMap[c] || c; });

    // 規則 5: 全角符號轉半角
    var symbolMap = {
        '（': '(', '）': ')', '。': '.', '、': ', ',
        '！': '!', '？': '?', '・': '-', '：': ':',
        '；': ';', '「': '"', '」': '"', '『': "'", '』': "'",
        '　': ' ', '～': '~', '…': '...', '―': '-',
        '×': ' x ', '＆': ' & ', '／': '/'
    };
    Object.keys(symbolMap).forEach(function(sym) {
        romaji = romaji.split(sym).join(symbolMap[sym]);
    });

    // 規則 5: × 和 & 兩側確保空格
    romaji = romaji.replace(/\s*x\s*/g, ' x ');
    romaji = romaji.replace(/\s*&\s*/g, ' & ');

    // 規則 2: 助詞特殊讀音（空白包圍時才替換）
    romaji = romaji.replace(/(^|\s)wo(\s|$)/g, '$1o$2');
    romaji = romaji.replace(/(^|\s)he(\s|$)/g, '$1e$2');
    romaji = romaji.replace(/(^|\s)ha(\s|$)/g, '$1wa$2');

    // 助詞小寫（空格包圍的短詞）
    var particles = ['no', 'ga', 'ni', 'wo', 'o', 'wa', 'e', 'de', 'to', 'mo',
                     'ka', 'ya', 'na', 'kara', 'made', 'yori', 'demo', 'nomi',
                     'dake', 'shika', 'sae', 'mo', 'desu', 'masu', 'da', 'ne', 'yo'];
    particles.forEach(function(p) {
        var re = new RegExp('(\s)' + p + '(\s|$)', 'g');
        romaji = romaji.replace(re, function(match, pre, post) {
            return pre + p + post;
        });
    });

    // 規則 6: 促音 tch → cch (えっち → Ecchi)
    romaji = romaji.replace(/tch/gi, 'cch');

    // 規則 6: 句末促音省略（っ! → !）
    romaji = romaji.replace(/xtsu([!?.）)~])/gi, '$1');
    romaji = romaji.replace(/ltu([!?.）)~])/gi, '$1');

    // 規則 11: 敬語連字符
    HONORIFICS.forEach(function(h) {
        var re = new RegExp('([a-zA-Z])\s+(' + h + ')(?=\s|$|[^a-zA-Z])', 'gi');
        romaji = romaji.replace(re, function(match, prev, honorific) {
            return prev + '-' + honorific.toLowerCase();
        });
    });

    // 規則 3: 本 Hon/Bon
    romaji = romaji.replace(/(\w+)\s+hon/gi, function(match, prev) {
        return prev + ' Bon';
    });

    // 規則 10: 年月格式（2025年8月号 → 2025-08）
    romaji = romaji.replace(/(\d{4})\s*nen\s*(\d{1,2})\s*gatsu\s*(?:gou|go|号)?/gi, function(match, year, month) {
        return year + '-' + ('0' + month).slice(-2);
    });

    // 大小寫規則：
    // 1. 先將全部字母強制小寫（除了已確認要保留的）
    // 2. 每個詞首字母大寫
    // 3. 助詞保持小寫

    // 括號內容獨立處理（保留英文原樣）
    var segments = [];
    var current = '';
    var depth = 0;
    for (var ci = 0; ci < romaji.length; ci++) {
        var ch = romaji[ci];
        if (ch === '(' || ch === '[') {
            if (depth === 0 && current) { segments.push({ text: current, isBracket: false }); current = ''; }
            depth++;
            current += ch;
        } else if (ch === ')' || ch === ']') {
            depth--;
            current += ch;
            if (depth === 0) { segments.push({ text: current, isBracket: true }); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) segments.push({ text: current, isBracket: false });

    var particleSet = {};
    particles.forEach(function(p) { particleSet[p] = true; });

    romaji = segments.map(function(seg) {
        if (seg.isBracket) {
            // 括號內：保留原樣，只修正首字母
            return seg.text.replace(/\(([a-z])/g, function(m, c) { return '(' + c.toUpperCase(); })
                           .replace(/\[([a-z])/g, function(m, c) { return '[' + c.toUpperCase(); });
        }
        // 非括號內：每個詞首字母大寫，助詞保持小寫
        return seg.text.replace(/(?:^|(?<=\s))([a-zA-Z]+)/g, function(word) {
            var lower = word.toLowerCase();
            // 全大寫英文保留（如 THE、ANGEL、NTR）
            if (word === word.toUpperCase() && word.length > 1 && /^[A-Z]+$/.test(word)) {
                return word;
            }
            // 助詞小寫
            if (particleSet[lower]) {
                return lower;
            }
            // 其他詞首字母大寫
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        });
    }).join('');

    // 修正行首助詞（行首的助詞也要大寫）
    romaji = romaji.replace(/^([a-z])/, function(c) { return c.toUpperCase(); });

    // 整理多餘空白
    romaji = romaji.replace(/\s+/g, ' ').trim();

    // 修正括號前後空格
    romaji = romaji.replace(/\s+\)/g, ')');
    romaji = romaji.replace(/\(\s+/g, '(');
    romaji = romaji.replace(/\)\s+\(/g, ') (');

    return romaji;
}

function convertToRomaji(text, romanBtn, outputField) {

    if (!text || !text.trim()) {
        _warn('[Romanization] 輸入文字為空');
        return;
    }

    romanBtn.disabled = true;
    _log('[DIAG] === 分詞診斷 ===');
    _log('[DIAG] 輸入文字:', text);
    preprocessLoanwords(text).then(function(preprocessed) {
        _log('[DIAG] preprocessLoanwords 輸出:', preprocessed);
        _log('[DIAG] user_dicts:', JSON.stringify(GM_getValue('user_dicts', {})));
    });
    romanBtn.textContent = '初始化中...';

    preprocessLoanwords(text).then(function(preprocessed) {
        _log('[Romanization] 預處理後:', preprocessed);
        return initKuroshiro().then(function(success) {
            if (!success && !_kuroshiroReady) {
                _error('[Romanization] Kuroshiro 初始化失敗');
                romanBtn.textContent = '初始化失敗';
                romanBtn.style.backgroundColor = '#CC0000';
                romanBtn.style.color = '#FFFFFF';
                setTimeout(function() {
                    romanBtn.disabled = false;
                    romanBtn.textContent = 'Romanization';
                    romanBtn.style.backgroundColor = '#E0DED3';
                    romanBtn.style.color = '#5C0D12';
                }, 2000);
                return;
            }
            romanBtn.textContent = '轉換中...';
            _kuroshiro._analyzer.parse(preprocessed).then(function(tokens) {
                _log('[Romanization] 分詞完成，共', tokens.length, '個 token');
                  processTokens(tokens).then(function(result) {
                      result = applyRomajiRules(result);
                      _log('[Romanization] 最終結果:', result);
                      outputField.value = result;
                      romanBtn.disabled = false;
                      romanBtn.textContent = 'Romanization';
                  }).catch(function(err) {
                      _error('[Romanization] Token 轉換失敗:', err.message || err);
                      romanBtn.textContent = '轉換失敗';
                      romanBtn.style.backgroundColor = '#CC0000';
                      romanBtn.style.color = '#FFFFFF';
                      setTimeout(function() {
                          romanBtn.disabled = false;
                          romanBtn.textContent = 'Romanization';
                          romanBtn.style.backgroundColor = '#E0DED3';
                          romanBtn.style.color = '#5C0D12';
                      }, 2000);
                  });
              }).catch(function(err) {
                  _error('[Romanization] 分詞失敗:', err.message || err);
                romanBtn.textContent = '轉換失敗';
                romanBtn.style.backgroundColor = '#CC0000';
                romanBtn.style.color = '#FFFFFF';
                setTimeout(function() {
                    romanBtn.disabled = false;
                    romanBtn.textContent = 'Romanization';
                    romanBtn.style.backgroundColor = '#E0DED3';
                    romanBtn.style.color = '#5C0D12';
                }, 2000);
            });
        });
    }).catch(function(err) {
        _error('[Romanization] 預處理失敗:', err.message || err);
        romanBtn.disabled = false;
        romanBtn.textContent = 'Romanization';
    });
}

// ==================== 頂層函數：createGalleryGroup ====================

function createGalleryGroup(groupIndex, savedData, tbody, folderRow1, sectionDiv, waitingCreateCountRef) {
var fragment = document.createDocumentFragment();

var tr1 = document.createElement('tr');

var td1_1 = document.createElement('td');
td1_1.className = 'gtc1';
td1_1.style.paddingLeft = '10px';

var mainLabel = document.createElement('span');
mainLabel.textContent = 'Main:';
mainLabel.style.cssText = 'font-size: 9pt; display: inline-block; width: 34px; text-align: left; margin-right: 4px; white-space: nowrap; vertical-align: middle;';
td1_1.appendChild(mainLabel);

var inputTitle = document.createElement('input');
inputTitle.type = 'text';
inputTitle.value = savedData ? savedData.title1 : '';
inputTitle.style.cssText =
'width: calc(100% - 42px) !important;' +
'box-sizing: border-box !important;' +
'border: 1px solid #5C0D12 !important;' +
'background-color: #E0DED3 !important;' +
'font-size: 9pt !important;' +
'height: 20px !important;' +
'padding: 0 4px !important;' +
'vertical-align: middle !important;';
td1_1.appendChild(inputTitle);

var td1_2 = document.createElement('td');
td1_2.className = 'gtc3';
td1_2.style.cssText = 'position: relative !important; padding: 0 !important;';
var filesSpan = document.createElement('span');
filesSpan.className = 'files-text';
filesSpan.textContent = savedData ? savedData.files : 'N/A';
filesSpan.style.cssText = 'font-size: 9pt; white-space: nowrap;';
td1_2.appendChild(filesSpan);

var td1_3 = document.createElement('td');
td1_3.className = 'gtc4';
td1_3.style.cssText = 'text-align: left !important; padding-left: 2px !important;';
var categorySelect = createCategorySelect(savedData ? savedData.category : 'Doujinshi');
categorySelect.style.marginLeft = '0';
categorySelect.style.display = 'block';
td1_3.appendChild(categorySelect);

var td1_4 = document.createElement('td');
td1_4.className = 'gtc4';
td1_4.style.cssText = 'text-align: left !important; padding-left: 2px !important;';
var langSelect = createLangSelect();
if (savedData && savedData.language) {
Array.from(langSelect.options).forEach(function(opt) { if (opt.value === savedData.language) opt.selected = true; });
}
td1_4.appendChild(langSelect);

var td1_5 = document.createElement('td');
td1_5.className = 'gtc4';
td1_5.style.cssText = 'text-align: left !important; padding-left: 2px !important;';
var folderSelect = createFolderSelect();
if (savedData && savedData.folder) {
Array.from(folderSelect.options).forEach(function(opt) { if (opt.value === savedData.folder) opt.selected = true; });
}
td1_5.appendChild(folderSelect);

var td1_6 = document.createElement('td');
td1_6.className = 'gtc6';
td1_6.style.cssText = 'padding-right: 0 !important; display: flex !important; align-items: center !important; justify-content: flex-end !important;';
var cb = document.createElement('input');
cb.type = 'checkbox';
cb.style.cssText = 'margin: 2px 3.5px 0 0 !important; vertical-align: middle !important; accent-color: #5C0D12 !important;';
td1_6.appendChild(cb);

tr1.appendChild(td1_1);
tr1.appendChild(td1_2);
tr1.appendChild(td1_3);
tr1.appendChild(td1_4);
tr1.appendChild(td1_5);
tr1.appendChild(td1_6);
fragment.appendChild(tr1);

var tr2 = document.createElement('tr');

var td2_1 = document.createElement('td');
td2_1.className = 'gtc1';
td2_1.style.cssText = 'padding-left: 10px !important; vertical-align: top !important; padding-top: 2px !important;';

var jpLabel = document.createElement('span');
jpLabel.textContent = 'JP:';
jpLabel.style.cssText = 'font-size: 9pt; display: inline-block; width: 34px; text-align: left; margin-right: 4px; white-space: nowrap; vertical-align: top; padding-top: 2px;';
td2_1.appendChild(jpLabel);

var inputTitle2 = document.createElement('input');
inputTitle2.type = 'text';
inputTitle2.value = savedData ? savedData.title2 : '';
inputTitle2.style.cssText =
'width: calc(100% - 42px) !important;' +
'box-sizing: border-box !important;' +
'border: 1px solid #5C0D12 !important;' +
'background-color: #E0DED3 !important;' +
'font-size: 9pt !important;' +
'height: 20px !important;' +
'padding: 0 4px !important;' +
'vertical-align: top !important;';
td2_1.appendChild(inputTitle2);

var tplRow = document.createElement('div');
tplRow.style.cssText = 'display: flex; justify-content: flex-start; align-items: center; gap: 4px; margin-top: 2px;';

var tplLabel = document.createElement('span');
tplLabel.textContent = 'Comment Template:';
tplLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0;';
tplRow.appendChild(tplLabel);

var tplSelect = document.createElement('select');
tplSelect.className = 'comment-template-select';
applySelectStyle(tplSelect, '130px');
var noneOpt = document.createElement('option');
noneOpt.value = '';
noneOpt.textContent = '----------None----------';
tplSelect.appendChild(noneOpt);
var existingTemplates = [];
try { existingTemplates = GM_getValue('comment_templates', []); } catch(e) {}
    if (!existingTemplates || !Array.isArray(existingTemplates)) { existingTemplates = []; }
    existingTemplates.forEach(function(tpl) {
var opt = document.createElement('option');
opt.value = tpl.id;
opt.textContent = tpl.name;
tplSelect.appendChild(opt);
});
tplRow.appendChild(tplSelect);

var tplGoBtn = document.createElement('button');
tplGoBtn.textContent = 'GO';
tplGoBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 6px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 18px; line-height: 16px; box-sizing: border-box; flex-shrink: 0;';
tplGoBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!tplSelect.value) return;
var templates = [];
try { templates = GM_getValue('comment_templates', []); } catch(err) {}
var found = templates.find(function(t) { return t.id === tplSelect.value; });
if (found) {
uploaderCommentTA.value = found.content;
uploaderCommentTA.style.height = 'auto';
uploaderCommentTA.style.height = uploaderCommentTA.scrollHeight + 'px';
}
});
tplRow.appendChild(tplGoBtn);
var tplSpacer = document.createElement('div'); tplSpacer.style.cssText = 'flex: 1;';
tplRow.appendChild(tplSpacer);
var romanBtn = document.createElement('button');
romanBtn.textContent = 'Romanization';
romanBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 6px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 18px; line-height: 16px; box-sizing: border-box; flex-shrink: 0;';
romanBtn.addEventListener('click', function(e) {
    e.preventDefault();
    convertToRomaji(inputTitle2.value.trim(), romanBtn, inputTitle);
});
tplRow.appendChild(romanBtn);
td2_1.appendChild(tplRow);

var td2_2 = document.createElement('td');
td2_2.className = 'gtc3';
td2_2.style.cssText = 'position: relative !important; padding: 0 !important; vertical-align: top !important;';

var swapBtn = document.createElement('button');
swapBtn.innerHTML = '&#8645;';
swapBtn.title = 'Swap Main/JP titles';
swapBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: pointer; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 0; white-space: nowrap; width: 26px;';
swapBtn.addEventListener('click', function(e) { e.preventDefault(); var tmp = inputTitle.value; inputTitle.value = inputTitle2.value; inputTitle2.value = tmp; });
td2_2.appendChild(swapBtn);

var savedDataId = (savedData && savedData.id && savedData.id !== 'undefined') ? savedData.id : null;

var zipBtn = document.createElement('button');
zipBtn.textContent = 'ZIP';
zipBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: pointer; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 2px 0 0 0; white-space: nowrap; width: 26px;';
var zipInput = document.createElement('input');
zipInput.type = 'file';
zipInput.accept = '.zip,.z01,.z02,.z03,.z04,.z05,.z06,.z07,.z08,.z09';
zipInput.multiple = true;
zipInput.style.display = 'none';
zipInput.addEventListener('change', function() {
var files = Array.from(zipInput.files);
if (!files.length) return;
_log('[ZIP] 開始處理:', files.map(function(f) { return f.name; }).join(', '));
var confirmColorMs = currentSettings.confirmBtnColorMs || 1000;
handleArchiveFiles(files, archiveStatusBtn, function(results) {
if (results.length === 0) return;
var allFiles = [];
results.forEach(function(r) { allFiles = allFiles.concat(r.files); });
allFiles.sort(function(a, b) { return naturalCompare(a.path, b.path); });
if (allFiles.length > MAX_FILES) {
_warn('[ZIP] 文件數超過限制，截斷至', MAX_FILES, '原數量:', allFiles.length);
allFiles = allFiles.slice(0, MAX_FILES);
}
_log('[ZIP] 處理完成，有效文件:', allFiles.length);
filesSpan.textContent = allFiles.length;
requestAnimationFrame(function() { alignFilesText(filesSpan, td1_2); });
if (savedDataId) {
var fileList = {};
try { fileList = GM_getValue('file_lists', {}); } catch(e) {}
fileList[savedDataId] = { folderName: null, files: allFiles };
GM_setValue('file_lists', fileList);
}
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
if (currentSettings.confirmBtnColorChange !== false) {
archiveStatusBtn.textContent = '✓';
archiveStatusBtn.style.backgroundColor = '#00AA00';
archiveStatusBtn.style.color = '#FFFFFF';
setTimeout(function() { archiveStatusBtn.textContent = ''; archiveStatusBtn.style.backgroundColor = '#E0DED3'; archiveStatusBtn.style.color = '#5C0D12'; }, confirmColorMs);
} else {
archiveStatusBtn.textContent = '✓';
setTimeout(function() { archiveStatusBtn.textContent = ''; }, 1000);
}
});
zipInput.value = '';
});
zipBtn.addEventListener('click', function(e) { e.preventDefault(); zipInput.click(); });
td2_2.appendChild(zipBtn);
td2_2.appendChild(zipInput);

var folderScanBtn = document.createElement('button');
folderScanBtn.textContent = '📁';
folderScanBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: pointer; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 2px 0 0 0; white-space: nowrap; width: 26px;';
folderScanBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!window.showDirectoryPicker) { _log('showDirectoryPicker not supported'); return; }
_log('[Folder] 開始掃描目錄');
archiveStatusBtn.textContent = '...';
archiveStatusBtn.style.backgroundColor = '#E0DED3';
window.showDirectoryPicker({ mode: 'read' }).then(function(dirHandle) {
var imageFiles = [];
var skipped = 0;
var fileCount = 0;
function scanDir(handle, prefix) {
_log('[Progress] 文件夾:', prefix || '/');
var entries = handle.values();
function processEntries() {
return entries.next().then(function(result) {
if (result.done) return;
var entry = result.value;
var fullPath = prefix ? prefix + '/' + entry.name : entry.name;
if (entry.kind === 'file') {
fileCount++;
_log('[Progress] 文件:', fullPath);
var ext = entry.name.split('.').pop().toLowerCase();
if (ACCEPTED_FORMATS.indexOf(ext) === -1) { skipped++; _log('[Folder] 過濾不支持格式:', fullPath); return processEntries(); }
imageFiles.push({ name: entry.name, path: fullPath });
return processEntries();
} else if (entry.kind === 'directory') {
return handle.getDirectoryHandle(entry.name).then(function(subHandle) {
return scanDir(subHandle, fullPath).then(processEntries);
});
}
return processEntries();
});
}
return processEntries();
}
scanDir(dirHandle, '').then(function() {
imageFiles.sort(function(a, b) { return naturalCompare(a.path, b.path); });
if (imageFiles.length > MAX_FILES) {
_warn('[Folder] 文件數超過限制，截斷至', MAX_FILES, '原數量:', imageFiles.length);
imageFiles = imageFiles.slice(0, MAX_FILES);
}
_log('[Folder] 掃描完成，有效文件:', imageFiles.length, '跳過:', skipped, '總掃描:', fileCount);
filesSpan.textContent = imageFiles.length;
requestAnimationFrame(function() { alignFilesText(filesSpan, td1_2); });
if (savedDataId) {
var fileList = {};
try { fileList = GM_getValue('file_lists', {}); } catch(e) {}
fileList[savedDataId] = { folderName: dirHandle.name, files: imageFiles };
GM_setValue('file_lists', fileList);
}
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
var confirmColorMs = currentSettings.confirmBtnColorMs || 1000;
if (currentSettings.confirmBtnColorChange !== false) {
archiveStatusBtn.textContent = '✓';
archiveStatusBtn.style.backgroundColor = '#00AA00';
archiveStatusBtn.style.color = '#FFFFFF';
setTimeout(function() { archiveStatusBtn.textContent = ''; archiveStatusBtn.style.backgroundColor = '#E0DED3'; archiveStatusBtn.style.color = '#5C0D12'; }, confirmColorMs);
} else {
archiveStatusBtn.textContent = '✓';
setTimeout(function() { archiveStatusBtn.textContent = ''; }, 1000);
}
});
}).catch(function(err) {
if (err.name !== 'AbortError') {
_error('Directory picker error:', err);
archiveStatusBtn.textContent = '✕';
archiveStatusBtn.style.backgroundColor = '#CC0000';
archiveStatusBtn.style.color = '#FFFFFF';
setTimeout(function() { archiveStatusBtn.textContent = ''; archiveStatusBtn.style.backgroundColor = '#E0DED3'; archiveStatusBtn.style.color = '#5C0D12'; }, 2000);
} else {
archiveStatusBtn.textContent = '';
archiveStatusBtn.style.backgroundColor = '#E0DED3';
}
});
});
td2_2.appendChild(folderScanBtn);

var archiveStatusBtn = document.createElement('div');
archiveStatusBtn.textContent = '';
archiveStatusBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: default; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 2px 0 0 0; white-space: nowrap; text-align: center; width: 26px;';
td2_2.appendChild(archiveStatusBtn);

requestAnimationFrame(function() {
requestAnimationFrame(function() {
alignSwapBtn([swapBtn, zipBtn, folderScanBtn, archiveStatusBtn], td2_2);
alignFilesText(filesSpan, td1_2);
});
});

var td2_merge = document.createElement('td');
td2_merge.colSpan = 3;
td2_merge.className = 'gtc-options';
td2_merge.style.cssText = 'padding: 2px 4px 2px 0 !important; vertical-align: top !important; text-align: left !important; position: relative;';

var mutexGroup = 'mutex_' + groupIndex;
var mtlOption = createPlainCheckbox('MTL', '', true);
var mtlSpan = mtlOption.container;
mtlSpan.style.cssText = 'position: absolute !important; display: none !important; background-color: transparent !important; z-index: 10 !important; white-space: nowrap !important; align-items: center !important;';
td2_merge.appendChild(mtlSpan);

var optionsGrid = document.createElement('div');
optionsGrid.className = 'options-grid';
optionsGrid.style.cssText = 'display: grid !important; grid-template-columns: repeat(3, max-content) !important; gap: 4px 16px !important; align-items: start !important;';

var cbOfficialTextless = createPlainCheckbox('Official / Textless', mutexGroup, false);
var cbAIGenerated      = createPlainCheckbox('AI Generated/AI生成', '', true);
var cbAnthology        = createPlainCheckbox('Anthology/アンソロジー', '', true);
var cbTranslated       = createPlainCheckbox('Translated', mutexGroup, false);
var cbDecensored       = createPlainCheckbox('Decensored/無修正', '', true);
var cbIncomplete       = createPlainCheckbox('Incomplete/ページ欠落', '', true);
var cbRewrite          = createPlainCheckbox('Rewrite', mutexGroup, false);
var cbColorized        = createPlainCheckbox('Colorized/カラー化', '', true);
var cbOngoing          = createPlainCheckbox('Ongoing/進行中', '', true);
var cbMtlPlaceholder   = document.createElement('span');
cbMtlPlaceholder.style.cssText = 'display: inline-block; width: 1px; height: 1px;';
var cbDigital          = createPlainCheckbox('Digital/DL版', '', true);
var cbSample           = createPlainCheckbox('Sample/見本', '', true);

optionsGrid.appendChild(cbOfficialTextless.container);
optionsGrid.appendChild(cbAIGenerated.container);
optionsGrid.appendChild(cbAnthology.container);
optionsGrid.appendChild(cbTranslated.container);
optionsGrid.appendChild(cbDecensored.container);
optionsGrid.appendChild(cbIncomplete.container);
optionsGrid.appendChild(cbRewrite.container);
optionsGrid.appendChild(cbColorized.container);
optionsGrid.appendChild(cbOngoing.container);
optionsGrid.appendChild(cbMtlPlaceholder);
optionsGrid.appendChild(cbDigital.container);
optionsGrid.appendChild(cbSample.container);
td2_merge.appendChild(optionsGrid);

if (!savedData) { cbOfficialTextless.checkbox.checked = true; }
if (savedData && savedData.options) {
if (savedData.options.official)    cbOfficialTextless.checkbox.checked = true;
if (savedData.options.translated) { cbTranslated.checkbox.checked = true; mtlSpan.style.display = 'inline-flex'; if (savedData.mtl) mtlOption.checkbox.checked = true; }
if (savedData.options.rewrite)     cbRewrite.checkbox.checked = true;
if (savedData.options.digital)     cbDigital.checkbox.checked = true;
if (savedData.options.decensored)  cbDecensored.checkbox.checked = true;
if (savedData.options.aiGenerated) cbAIGenerated.checkbox.checked = true;
if (savedData.options.colorized)   cbColorized.checkbox.checked = true;
if (savedData.options.incomplete)  cbIncomplete.checkbox.checked = true;
if (savedData.options.ongoing)     cbOngoing.checkbox.checked = true;
if (savedData.options.sample)      cbSample.checkbox.checked = true;
if (savedData.options.anthology)   cbAnthology.checkbox.checked = true;
}

function positionMtlSpan() {
var tdRect = td2_merge.getBoundingClientRect();
var children = optionsGrid.children;
if (children.length >= 10) {
var row4First = children[9];
var row4Rect = row4First.getBoundingClientRect();
var gridRect = optionsGrid.getBoundingClientRect();
mtlSpan.style.top = (row4Rect.top - tdRect.top) + 'px';
mtlSpan.style.left = (gridRect.left - tdRect.left) + 'px';
}
}
requestAnimationFrame(function() { requestAnimationFrame(function() { positionMtlSpan(); }); });

cbOfficialTextless.checkbox.addEventListener('click', function() {
if (!cbTranslated.checkbox.checked && !cbRewrite.checkbox.checked) { this.checked = true; return; }
cbTranslated.checkbox.checked = false; cbRewrite.checkbox.checked = false; mtlSpan.style.display = 'none'; mtlOption.checkbox.checked = false;
});
cbTranslated.checkbox.addEventListener('click', function() {
if (!cbOfficialTextless.checkbox.checked && !cbRewrite.checkbox.checked) { this.checked = true; return; }
cbOfficialTextless.checkbox.checked = false; cbRewrite.checkbox.checked = false; mtlSpan.style.display = 'inline-flex';
if (currentSettings.translatedDefaultMTL) { mtlOption.checkbox.checked = true; }
});
cbRewrite.checkbox.addEventListener('click', function() {
if (!cbOfficialTextless.checkbox.checked && !cbTranslated.checkbox.checked) { this.checked = true; return; }
cbOfficialTextless.checkbox.checked = false; cbTranslated.checkbox.checked = false; mtlSpan.style.display = 'none'; mtlOption.checkbox.checked = false;
});
langSelect.addEventListener('change', function() {
if (currentSettings.nonJapaneseDefaultTranslated && this.value !== '0') {
cbTranslated.checkbox.checked = true; cbOfficialTextless.checkbox.checked = false; cbRewrite.checkbox.checked = false;
mtlSpan.style.display = 'inline-flex';
if (currentSettings.translatedDefaultMTL) { mtlOption.checkbox.checked = true; }
}
});

var uploaderRow = document.createElement('div');
uploaderRow.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; margin-top: 4px;';

var uploaderBtn = document.createElement('button');
uploaderBtn.textContent = 'Uploader Comment';
uploaderBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 24px; line-height: 20px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0;';
uploaderRow.appendChild(uploaderBtn);

var uploaderCommentTA = document.createElement('textarea');
uploaderCommentTA.className = 'uploader-comment-ta';
uploaderCommentTA.rows = 1;
uploaderCommentTA.style.cssText = 'flex: 1 1 0; min-width: 0; border: 1px solid #5C0D12; background-color: #E0DED3; font-size: 9pt; padding: 2px 4px; resize: none; overflow-y: hidden; font-family: inherit; box-sizing: border-box; min-height: 24px; height: 24px; line-height: 20px; margin: 0;';
if (savedData && savedData.comment) { uploaderCommentTA.value = savedData.comment; }
uploaderCommentTA.addEventListener('input', function() {
this.style.height = '24px';
this.style.height = this.scrollHeight + 'px';
});

uploaderBtn.addEventListener('click', function(e) {
e.preventDefault();
var isExpanded = parseInt(uploaderCommentTA.style.height) > 24;
if (isExpanded) { uploaderCommentTA.style.height = '24px'; uploaderCommentTA.style.overflowY = 'hidden'; }
else { uploaderCommentTA.style.height = '24px'; uploaderCommentTA.style.height = uploaderCommentTA.scrollHeight + 'px'; uploaderCommentTA.style.overflowY = 'auto'; uploaderCommentTA.focus(); }
});
uploaderRow.appendChild(uploaderCommentTA);

var saveCommentBtn = document.createElement('button');
saveCommentBtn.textContent = 'save';
saveCommentBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 24px; line-height: 20px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0;';
saveCommentBtn.addEventListener('click', function(e) {
e.preventDefault();
var mtlCb = mtlSpan.querySelector('input[type="checkbox"]');
var galleryData = {
id: savedDataId || (Date.now() + '_' + inputTitle.value),
title1: inputTitle.value,
title2: inputTitle2.value,
files: td1_2.textContent,
category: categorySelect.value,
language: langSelect.value,
folder: folderSelect.value,
options: {
official: cbOfficialTextless.checkbox.checked, translated: cbTranslated.checkbox.checked,
rewrite: cbRewrite.checkbox.checked, digital: cbDigital.checkbox.checked,
decensored: cbDecensored.checkbox.checked, aiGenerated: cbAIGenerated.checkbox.checked,
colorized: cbColorized.checkbox.checked, incomplete: cbIncomplete.checkbox.checked,
ongoing: cbOngoing.checkbox.checked, sample: cbSample.checkbox.checked,
anthology: cbAnthology.checkbox.checked, textless: false
},
mtl: mtlCb ? mtlCb.checked : false,
comment: uploaderCommentTA.value,
timestamp: Date.now()
};
try {
var existingGalleries = GM_getValue('saved_galleries', []);
if (savedDataId) { existingGalleries = existingGalleries.filter(function(g) { return g.id !== savedDataId; }); }
  if (!Array.isArray(existingGalleries)) { existingGalleries = []; }
  existingGalleries.push(galleryData);
GM_setValue('saved_galleries', existingGalleries);
savedDataId = galleryData.id;
tr2.dataset.savedDataId = savedDataId;
saveCommentBtn.style.backgroundColor = '#999999';
saveCommentBtn.style.color = '#CCCCCC';
saveCommentBtn.style.borderColor = '#999999';
setTimeout(function() { saveCommentBtn.style.backgroundColor = '#E0DED3'; saveCommentBtn.style.color = '#5C0D12'; saveCommentBtn.style.borderColor = '#5C0D12'; }, 500);
_log('[Save] 已靜默保存畫廊:', galleryData.id, galleryData.title1);
} catch(error) { _error('Save failed:', error); }
});
uploaderRow.appendChild(saveCommentBtn);
td2_1.appendChild(uploaderRow);

var td2_6 = document.createElement('td');
td2_6.className = 'gtc6';
td2_6.style.cssText = 'padding-right: 3.5px !important; display: flex !important; flex-direction: column !important; align-items: flex-end !important; justify-content: flex-start !important; gap: 2px !important; vertical-align: top !important; padding-top: 2px !important;';

var plusBtn = document.createElement('button');
plusBtn.textContent = '+';
plusBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; width: 13px; height: 13px; line-height: 11px; cursor: pointer; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0; margin: 0 !important;';
plusBtn.addEventListener('click', function(e) {
e.preventDefault();
try {
var categoryMap = { 'Doujinshi': '2', 'Manga': '3', 'Artist CG': '4', 'Game CG': '5', 'Western': '10', 'Non-H': '9', 'Image Set': '6', 'Cosplay': '7', 'Misc': '1' };
var langTypeVal = '0';
if (cbTranslated.checkbox.checked) langTypeVal = '1';
else if (cbRewrite.checkbox.checked) langTypeVal = '2';
var mainVal = inputTitle.value;
var jpVal = inputTitle2.value;
if (mainVal && !jpVal) jpVal = mainVal;
else if (!mainVal && jpVal) mainVal = jpVal;
var pendingData = {
id: Date.now() + '_' + mainVal,
title1: mainVal, title2: jpVal,
files: td1_2.textContent,
category: categoryMap[categorySelect.value] || '2',
categoryText: categorySelect.value,
language: langSelect.value, folder: folderSelect.value,
langtype: langTypeVal, mtl: mtlOption.checkbox.checked,
comment: uploaderCommentTA.value, savedDataId: savedDataId,
options: {
official: cbOfficialTextless.checkbox.checked, translated: cbTranslated.checkbox.checked,
rewrite: cbRewrite.checkbox.checked, digital: cbDigital.checkbox.checked,
decensored: cbDecensored.checkbox.checked, aiGenerated: cbAIGenerated.checkbox.checked,
colorized: cbColorized.checkbox.checked, textless: false,
incomplete: cbIncomplete.checkbox.checked, sample: cbSample.checkbox.checked,
anthology: cbAnthology.checkbox.checked, ongoing: cbOngoing.checkbox.checked
}
};
GM_setValue('pending_create', pendingData);
GM_openInTab('https://upload.e-hentai.org/managegallery?act=new', { active: false });
} catch(err) { _error('+ 按鈕錯誤:', err.message); }
});
td2_6.appendChild(plusBtn);

var deletePending = false;
var deleteTimer = null;

function resetDeleteConfirm() {
if (deletePending) { deletePending = false; deleteBtn.style.backgroundColor = '#E0DED3'; deleteBtn.style.color = '#5C0D12'; }
if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
}

var deleteBtn = document.createElement('button');
deleteBtn.textContent = '-';
deleteBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; width: 13px; height: 13px; line-height: 11px; cursor: pointer; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0; margin: 0 !important;';
deleteBtn.addEventListener('click', function(e) {
e.preventDefault(); e.stopPropagation();
if (!currentSettings.deleteDoubleConfirm) {
[tr1, tr2].forEach(function(row) { row.remove(); });
waitingCreateCountRef.value--;
var fs1 = folderRow1.querySelector('strong');
if (fs1) fs1.textContent = Math.max(0, waitingCreateCountRef.value);
if (savedDataId) {
try {
var eg = GM_getValue('saved_galleries', []);
GM_setValue('saved_galleries', eg.filter(function(g) { return g.id !== savedDataId; }));
var fl = GM_getValue('file_lists', {}); delete fl[savedDataId]; GM_setValue('file_lists', fl);
} catch(err) {}
}
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
return;
}
if (!deletePending) {
deletePending = true; deleteBtn.style.backgroundColor = '#FF0000'; deleteBtn.style.color = '#FFFFFF';
deleteTimer = setTimeout(function() { resetDeleteConfirm(); }, currentSettings.doubleConfirmMs || 1000);
} else {
resetDeleteConfirm();
[tr1, tr2].forEach(function(row) { row.remove(); });
waitingCreateCountRef.value--;
var fs1 = folderRow1.querySelector('strong');
if (fs1) fs1.textContent = Math.max(0, waitingCreateCountRef.value);
if (savedDataId) {
try {
var eg = GM_getValue('saved_galleries', []);
GM_setValue('saved_galleries', eg.filter(function(g) { return g.id !== savedDataId; }));
var fl = GM_getValue('file_lists', {}); delete fl[savedDataId]; GM_setValue('file_lists', fl);
} catch(err) {}
}
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
}
});
td2_6.appendChild(deleteBtn);

tr2.appendChild(td2_1);
tr2.appendChild(td2_2);
tr2.appendChild(td2_merge);
tr2.appendChild(td2_6);
fragment.appendChild(tr2);

return fragment;
}

// ==================== 頂層函數：loadSavedGalleries ====================

function loadSavedGalleries(tbody, folderRow1, folderRight1, sectionDiv, waitingCreateCountRef) {
try {
var saved = GM_getValue('saved_galleries', []);
if (!Array.isArray(saved) || saved.length === 0) return;
var validSaved = saved.filter(function(g) { return g && g.id && g.id !== 'undefined' && g.id !== undefined; });
if (validSaved.length !== saved.length) { GM_setValue('saved_galleries', validSaved); }
if (validSaved.length === 0) return;

var folderToggle1 = folderRow1.querySelector('.folder-toggle');
if (folderToggle1 && folderToggle1.textContent === '[+]') {
var nextRowCheck = folderRow1.nextElementSibling;
while (nextRowCheck) { nextRowCheck.style.display = 'table-row'; nextRowCheck = nextRowCheck.nextElementSibling; }
folderToggle1.textContent = '[-]';
var spans = folderRight1.querySelectorAll('span');
spans.forEach(function(span) { span.style.display = ''; });
}

validSaved.forEach(function(galleryData) {
var newGroup = createGalleryGroup(waitingCreateCountRef.value, galleryData, tbody, folderRow1, sectionDiv, waitingCreateCountRef);
tbody.appendChild(newGroup);
waitingCreateCountRef.value++;
});

var folderStrong1 = folderRow1.querySelector('strong');
if (folderStrong1) folderStrong1.textContent = waitingCreateCountRef.value;
requestAnimationFrame(function() { fixAllGroups(sectionDiv, folderRow1); });
} catch(error) { _error('載入保存的圖庫失敗:', error); }
}

// ==================== 壓縮檔工具函數 ====================

var _pendingVolumes = {};
var _volumeTimers = {};

function identifyVolumeParts(files) {
var groups = {};
files.forEach(function(file) {
var name = file.name;
var match;
match = name.match(/^(.+)\.zip\.(\d+)$/i);
if (match) { var base = match[1]; if (!groups[base]) groups[base] = { type: 'zip-split', parts: [], base: base }; groups[base].parts.push({ idx: parseInt(match[2]), file: file }); return; }
match = name.match(/^(.+)\.z(\d+)$/i);
if (match) { var base = match[1]; if (!groups[base]) groups[base] = { type: 'zip-z', parts: [], base: base }; groups[base].parts.push({ idx: parseInt(match[2]), file: file }); return; }
var ext = name.split('.').pop().toLowerCase();
if (ext === 'zip') {
var base = name.replace(/\.[^.]+$/, '');
if (!groups[base]) groups[base] = { type: 'zip-single', parts: [], base: base };
groups[base].parts.push({ idx: 0, file: file });
}
});
return groups;
}

function checkVolumesComplete(group) {
if (group.type.indexOf('single') !== -1) return true;
var parts = group.parts.slice().sort(function(a, b) { return a.idx - b.idx; });
if (parts.length < 2) return false;
var first = parts[0].idx;
for (var i = 1; i < parts.length; i++) {
if (parts[i].idx !== first + i) return false;
}
return true;
}

function mergeVolumeParts(group) {
var parts = group.parts.slice().sort(function(a, b) { return a.idx - b.idx; });
return Promise.all(parts.map(function(p) {
return p.file.arrayBuffer ? p.file.arrayBuffer() : new Response(p.file).arrayBuffer();
})).then(function(buffers) {
var totalSize = buffers.reduce(function(s, b) { return s + b.byteLength; }, 0);
var merged = new Uint8Array(totalSize);
var offset = 0;
buffers.forEach(function(buf) {
merged.set(new Uint8Array(buf), offset);
offset += buf.byteLength;
});
return merged.buffer;
});
}

function extractArchive(fileOrBuffer, fileName, onProgress) {
var ext = (fileName || '').split('.').pop().toLowerCase();
_log('[extractArchive] 開始處理:', fileName, '格式:', ext);
_log('[extractArchive] 使用 JSZip');
return extractWithJSZip(fileOrBuffer, onProgress);
}

function extractWithJSZip(fileOrBuffer, onProgress) {
_log('[JSZip] 開始載入 ZIP...');
return JSZip.loadAsync(fileOrBuffer).then(function(zip) {
_log('[JSZip] ZIP 載入成功，開始讀取文件列表...');
var imageFiles = [];
var skipped = 0;
var entries = [];
zip.forEach(function(relativePath, zipEntry) {
if (!zipEntry.dir) entries.push({ path: relativePath, entry: zipEntry });
});
var total = entries.length;
var done = 0;
_log('[JSZip] 共', total, '個文件，開始逐一處理...');
var _processNext_result = null;
function processNext(idx) {
if (idx >= entries.length) {
_log('[ZIP] 解壓完成，有效文件:', imageFiles.length, '跳過:', skipped);
return Promise.resolve({ files: imageFiles, skipped: skipped });
}
var item = entries[idx];
done++;
var ext = (item.entry.name || '').split('.').pop().toLowerCase();
if (ext === 'zip') {
_log('[Progress] ' + done + '/' + total + ' [內層ZIP] ' + item.path);
return item.entry.async('arraybuffer').then(function(buf) {
return extractArchive(buf, item.entry.name, onProgress);
}).then(function(result) {
result.files.forEach(function(f) { imageFiles.push(f); });
skipped += result.skipped;
return processNext(idx + 1);
}).catch(function(err) {
_warn('[JSZip] 內層解壓失敗:', item.path, err);
skipped++;
return processNext(idx + 1);
});
}
if (!validateFile(item.entry.name, 0)) {
skipped++;
_log('[Progress] ' + done + '/' + total + ' [跳過] ' + item.path);
return processNext(idx + 1);
}
_log('[Progress] ' + done + '/' + total + ' ' + item.path);
if (onProgress) onProgress(done, total, item.path);
imageFiles.push({ name: item.entry.name, path: item.path });
return Promise.resolve().then(function() { return processNext(idx + 1); });
}
return processNext(0);
});
}

function extractNestedArchives(files, depth, onProgress) {
if (depth > 5) {
_warn('[Nested] 遞迴深度超過5層，停止解壓');
return Promise.resolve(files);
}
var nestedPromises = [];
var finalFiles = [];
var processedCount = 0;
files.forEach(function(file) {
var ext = (file.name || file.path || '').split('.').pop().toLowerCase();
if (ext === 'zip' && file.buffer) {
_log('[Nested] 檢測到內層壓縮檔: ' + file.path + ' (深度:' + depth + ')');
nestedPromises.push(
extractArchive(file.buffer, file.name, onProgress)
.then(function(result) {
if (result.files.length > 0) {
_log('[Nested] 從 ' + file.path + ' 解壓出 ' + result.files.length + ' 個文件');
return extractNestedArchives(result.files, depth + 1, onProgress);
} else {
return [];
}
}).then(function(nestedFiles) {
finalFiles = finalFiles.concat(nestedFiles);
processedCount++;
}).catch(function(err) {
_error('[Nested] 解壓失敗:', file.path, err);
finalFiles.push(file);
})
);
} else {
finalFiles.push(file);
}
});
if (nestedPromises.length === 0) return Promise.resolve(finalFiles);
return Promise.all(nestedPromises).then(function() {
_log('[Nested] 深度' + depth + '處理完成，共 ' + finalFiles.length + ' 個最終文件');
return finalFiles;
});
}

function handleArchiveFiles(droppedFiles, statusBtn, onComplete) {
var groups = identifyVolumeParts(droppedFiles);
var keys = Object.keys(groups);
if (keys.length === 0) {
_warn('[Archive] 無可識別的壓縮檔');
if (statusBtn) { statusBtn.textContent = '✕'; statusBtn.style.backgroundColor = '#CC0000'; statusBtn.style.color = '#FFFFFF'; setTimeout(function() { statusBtn.textContent = ''; statusBtn.style.backgroundColor = '#E0DED3'; statusBtn.style.color = '#5C0D12'; }, 2000); }
return;
}
var results = [];
var processQueue = keys.slice();
function processNext() {
if (processQueue.length === 0) {
onComplete(results);
return;
}
var key = processQueue.shift();
var group = groups[key];
if (group.type === 'zip-single') {
var file = group.parts[0].file;
_log('[Archive] 處理單檔:', file.name);
if (statusBtn) { statusBtn.textContent = '...'; statusBtn.style.backgroundColor = '#E0DED3'; }
extractArchive(file, file.name, function(done, total, name) {
_log('[Progress] ' + done + '/' + total + ' ' + name);
}).then(function(result) {
result.title = group.base;
results.push(result);
processNext();
}).catch(function(err) {
_error('[Archive] 解壓失敗:', err);
if (statusBtn) { statusBtn.textContent = '✕'; statusBtn.style.backgroundColor = '#CC0000'; statusBtn.style.color = '#FFFFFF'; setTimeout(function() { statusBtn.textContent = ''; statusBtn.style.backgroundColor = '#E0DED3'; statusBtn.style.color = '#5C0D12'; }, 2000); }
processNext();
});
} else {
group.parts.forEach(function(p) {
if (!_pendingVolumes[key]) _pendingVolumes[key] = { type: group.type, parts: [], base: group.base };
var exists = _pendingVolumes[key].parts.some(function(ep) { return ep.idx === p.idx; });
if (!exists) _pendingVolumes[key].parts.push(p);
});
if (_volumeTimers[key]) clearTimeout(_volumeTimers[key]);
if (checkVolumesComplete(_pendingVolumes[key])) {
_log('[Archive] 分卷完整，合併:', key);
if (statusBtn) { statusBtn.textContent = '...'; statusBtn.style.backgroundColor = '#E0DED3'; }
mergeVolumeParts(_pendingVolumes[key]).then(function(merged) {
return extractWithJSZip(merged, function(done, total, name) {
_log('[Progress] ' + done + '/' + total + ' ' + name);
});
}).then(function(result) {
result.title = _pendingVolumes[key].base;
results.push(result);
delete _pendingVolumes[key];
delete _volumeTimers[key];
processNext();
}).catch(function(err) {
_error('[Archive] 分卷解壓失敗:', err);
if (statusBtn) { statusBtn.textContent = '✕'; statusBtn.style.backgroundColor = '#CC0000'; statusBtn.style.color = '#FFFFFF'; setTimeout(function() { statusBtn.textContent = ''; statusBtn.style.backgroundColor = '#E0DED3'; statusBtn.style.color = '#5C0D12'; }, 2000); }
delete _pendingVolumes[key];
delete _volumeTimers[key];
processNext();
});
} else {
_log('[Archive] 分卷不完整，等待:', key, '已有', _pendingVolumes[key].parts.length, '個');
if (statusBtn) { statusBtn.textContent = '⏳'; statusBtn.style.backgroundColor = '#CCAA00'; statusBtn.style.color = '#FFFFFF'; }
_volumeTimers[key] = setTimeout(function() {
_warn('[Archive] 分卷等待超時(60秒)，請重新讀取:', key);
if (statusBtn) { statusBtn.textContent = '✕'; statusBtn.style.backgroundColor = '#CC0000'; statusBtn.style.color = '#FFFFFF'; setTimeout(function() { statusBtn.textContent = ''; statusBtn.style.backgroundColor = '#E0DED3'; statusBtn.style.color = '#5C0D12'; }, 2000); }
delete _pendingVolumes[key];
delete _volumeTimers[key];
}, 60000);
processNext();
}
}
}
processNext();
}


function createDictManagerPanel() {

var container = document.createElement('div');
container.className = 'dict-manager-container';
container.style.cssText = 'display: none; padding: 10px; background-color: #E0DED3; border: 1px solid #5C0D12; position: relative;';

var title = document.createElement('div');
title.textContent = 'Dictionary Manager';
    title.textContent = 'Dict Manager';
    title.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12;';
    var updateDictBtn = document.createElement('button');
    updateDictBtn.textContent = 'Update Dict';
    updateDictBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 8px; cursor: pointer; border-radius: 3px; height: 22px;';
    updateDictBtn.addEventListener('click', function(e) { e.preventDefault(); updateAllDicts(updateDictBtn); });
    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
    titleRow.appendChild(title);
    titleRow.appendChild(updateDictBtn);
    container.appendChild(titleRow);

var body = document.createElement('div');
body.style.cssText = 'display: flex; gap: 0; min-height: 300px;';

var leftCol = document.createElement('div');
leftCol.style.cssText = 'width: 180px; flex-shrink: 0; display: flex; flex-direction: column; border: 1px solid #5C0D12; background: #E0DED3;';

var navList = document.createElement('div');
navList.style.cssText = 'flex: 1; overflow-y: auto;';

var rightCol = document.createElement('div');
rightCol.style.cssText = 'flex: 1; border: 1px solid #5C0D12; border-left: none; background: transparent; display: flex; flex-direction: column;';

var listBox = document.createElement('div');
listBox.style.cssText = 'flex: 1; overflow-y: auto; padding: 4px;';
rightCol.appendChild(listBox);

body.appendChild(leftCol);
body.appendChild(rightCol);
container.appendChild(body);

var groupStates = { local: false, external: false, kuromoji: false, jmdict: false };
var kuromojiItemsDiv = document.createElement('div');
var jmdictItemsDiv = document.createElement('div');

function makeGroupHeader(label, stateKey) {
    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; padding: 5px 8px 3px 8px; user-select: none; cursor: pointer; background: #D8D5C6; border-bottom: 1px solid #5C0D12; display: flex; align-items: center; gap: 4px;';
    var arrow = document.createElement('span');
    arrow.textContent = groupStates[stateKey] ? '▼' : '▶';
    arrow.style.cssText = 'font-size: 7pt; flex-shrink: 0;';
    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    hdr.appendChild(arrow);
    hdr.appendChild(labelSpan);
    hdr.addEventListener('click', function(e) {
        e.preventDefault();
        groupStates[stateKey] = !groupStates[stateKey];
        arrow.textContent = groupStates[stateKey] ? '▼' : '▶';
        renderNav();
    });
    return hdr;
}

function makeSubGroupHeader(label, stateKey) {
    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; padding: 4px 8px 4px 20px; user-select: none; cursor: pointer; background: #DCD9CA; border-bottom: 1px solid rgba(92,13,18,0.2); display: flex; align-items: center; gap: 4px;';
    var arrow = document.createElement('span');
    arrow.textContent = groupStates[stateKey] ? '▼' : '▶';
    arrow.style.cssText = 'font-size: 7pt; flex-shrink: 0;';
    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    hdr.appendChild(arrow);
    hdr.appendChild(labelSpan);
    hdr.addEventListener('click', function(e) {
        e.preventDefault();
        groupStates[stateKey] = !groupStates[stateKey];
        arrow.textContent = groupStates[stateKey] ? '▼' : '▶';
        renderNav();
    });
    return hdr;
}

function renderKuromojiItems() {
    kuromojiItemsDiv.innerHTML = '';
    var files = [
        'base.dat.gz','check.dat.gz','tid.dat.gz','tid_pos.dat.gz',
        'tid_map.dat.gz','cc.dat.gz','unk.dat.gz','unk_pos.dat.gz',
        'unk_map.dat.gz','unk_char.dat.gz','unk_compat.dat.gz','unk_invoke.dat.gz'
    ];
    Promise.all([
        Promise.all(files.map(function(f) {
            return dbGet('dicts', f).then(function(val) {
                return { name: f, cached: (val !== null && val !== undefined) };
            });
        })),
        dbGet('dicts', 'kuromoji_download_time')
    ]).then(function(results) {
        var fileResults = results[0];
        var savedTime = results[1];

        var summaryRow = document.createElement('div');
        summaryRow.style.cssText = 'font-size: 8.5pt; padding: 3px 8px 3px 32px; border-bottom: 1px solid rgba(92,13,18,0.1); color: #333; background: #E0DED3; display: flex; justify-content: space-between; align-items: center;';
        var allCached = fileResults.every(function(r) { return r.cached; });
        var summaryName = document.createElement('span');
        summaryName.textContent = allCached
            ? ('全部已下載' + (savedTime ? ' （本地時間: ' + new Date(savedTime).toLocaleDateString() + '）' : ''))
            : ('已下載: ' + fileResults.filter(function(r) { return r.cached; }).length + '/' + files.length);
        var summaryStatus = document.createElement('span');
        summaryStatus.textContent = allCached ? '✓' : '✗';
        summaryStatus.style.color = allCached ? '#007700' : '#CC0000';
        summaryRow.appendChild(summaryName);
        summaryRow.appendChild(summaryStatus);
        kuromojiItemsDiv.appendChild(summaryRow);

        fileResults.forEach(function(r) {
            var row = document.createElement('div');
            row.style.cssText = 'font-size: 8.5pt; padding: 2px 8px 2px 32px; border-bottom: 1px solid rgba(92,13,18,0.1); color: #333; background: #E0DED3; display: flex; justify-content: space-between;';
            var nameSpan = document.createElement('span'); nameSpan.textContent = r.name;
            var statusSpan = document.createElement('span');
            statusSpan.textContent = r.cached ? '✓' : '✗';
            statusSpan.style.color = r.cached ? '#007700' : '#CC0000';
            row.appendChild(nameSpan); row.appendChild(statusSpan);
            kuromojiItemsDiv.appendChild(row);
        });

        if (!allCached || !savedTime) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.github.com/repos/takuyaa/kuromoji.js/commits?path=dict&per_page=1',
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            onload: function(resp) {
                if (resp.status < 200 || resp.status >= 300) return;
                try {
                    var commits = JSON.parse(resp.responseText);
                    if (commits && commits.length > 0) {
                        var remoteTime = new Date(commits[0].commit.committer.date).getTime();
                        if (remoteTime > savedTime) {
                            summaryStatus.textContent = '⚠';
                            summaryStatus.style.color = '#CC6600';
                            summaryName.textContent = summaryName.textContent + ' → 有新版本 (' + new Date(remoteTime).toLocaleDateString() + ')';
                        }
                    }
                } catch(e) { _error('[Kuromoji] 版本比對失敗:', e.message); }
            },
            onerror: function() { _error('[Kuromoji] 無法訪問 GitHub API'); }
        });
    });
}

function renderJMdictItems() {
    jmdictItemsDiv.innerHTML = '';
    Promise.all([
        dbGet('dicts', 'jmdict_data'),
        dbGet('dicts', 'jmdict_download_time')
    ]).then(function(results) {
        var data = results[0];
        var savedTime = results[1];
        var hasData = data && Array.isArray(data) && data.length > 0;

        var statusRow = document.createElement('div');
        statusRow.style.cssText = 'font-size: 8.5pt; padding: 3px 8px 3px 32px; border-bottom: 1px solid rgba(92,13,18,0.1); color: #333; background: #E0DED3; display: flex; justify-content: space-between; align-items: center;';
        var nameSpan = document.createElement('span');
        var statusSpan = document.createElement('span');

        if (!hasData) {
            nameSpan.textContent = '未下載';
            statusSpan.textContent = '✗';
            statusSpan.style.color = '#CC0000';
            statusRow.appendChild(nameSpan);
            statusRow.appendChild(statusSpan);
            jmdictItemsDiv.appendChild(statusRow);
            return;
        }

        nameSpan.textContent = '條目數: ' + data.length + (savedTime ? ' （本地時間: ' + new Date(savedTime).toLocaleDateString() + '）' : '');
        statusSpan.textContent = '✓';
        statusSpan.style.color = '#007700';
        statusRow.appendChild(nameSpan);
        statusRow.appendChild(statusSpan);
        jmdictItemsDiv.appendChild(statusRow);

        if (!savedTime) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.github.com/repos/yomidevs/jmdict-yomitan/releases/latest',
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            onload: function(resp) {
                if (resp.status < 200 || resp.status >= 300) return;
                try {
                    var release = JSON.parse(resp.responseText);
                    var remoteTime = new Date(release.published_at).getTime();
                    if (remoteTime > savedTime) {
                        statusSpan.textContent = '⚠';
                        statusSpan.style.color = '#CC6600';
                        nameSpan.textContent = nameSpan.textContent + ' → 有新版本 (' + new Date(remoteTime).toLocaleDateString() + ')';
                    }
                } catch(e) { _error('[JMdict] 版本比對失敗:', e.message); }
            },
            onerror: function() { _error('[JMdict] 無法訪問 GitHub API'); }
        });
    });
}

function updateAllDicts(btn) {
    btn.disabled = true;
    btn.textContent = '更新中...';
    _log('[UpdateDict] 開始更新所有外部字典...');

    var KUROMOJI_FILES = [
        'base.dat.gz', 'check.dat.gz', 'tid.dat.gz',
        'tid_pos.dat.gz', 'tid_map.dat.gz', 'cc.dat.gz',
        'unk.dat.gz', 'unk_pos.dat.gz', 'unk_map.dat.gz',
        'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz'
    ];

    function checkKuromojiVersion() {
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.github.com/repos/takuyaa/kuromoji.js/commits?path=dict&per_page=1',
                headers: { 'Accept': 'application/vnd.github.v3+json' },
                onload: function(resp) {
                    if (resp.status < 200 || resp.status >= 300) { resolve(null); return; }
                    try {
                        var commits = JSON.parse(resp.responseText);
                        if (commits && commits.length > 0) {
                            resolve(new Date(commits[0].commit.committer.date).getTime());
                        } else { resolve(null); }
                    } catch(e) { resolve(null); }
                },
                onerror: function() { resolve(null); }
            });
        });
    }

    function checkJMdictVersion() {
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.github.com/repos/yomidevs/jmdict-yomitan/releases/latest',
                headers: { 'Accept': 'application/vnd.github.v3+json' },
                onload: function(resp) {
                    if (resp.status < 200 || resp.status >= 300) { resolve(null); return; }
                    try {
                        var release = JSON.parse(resp.responseText);
                        resolve(new Date(release.published_at).getTime());
                    } catch(e) { resolve(null); }
                },
                onerror: function() { resolve(null); }
            });
        });
    }

    function downloadKuromojiFile(fileName) {
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://cdn.jsdelivr.net/gh/takuyaa/kuromoji.js@master/dict/' + fileName,
                responseType: 'arraybuffer',
                onload: function(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.response);
                    } else {
                        reject(new Error('HTTP ' + resp.status));
                    }
                },
                onerror: function(err) { reject(new Error(err.error || '下載失敗')); },
                ontimeout: function() { reject(new Error('下載超時')); }
            });
        });
    }

    function downloadJMdictFull() {
        var JMDICT_URL = 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english.zip';
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: JMDICT_URL,
                responseType: 'arraybuffer',
                anonymous: true,
                redirect: 'follow',
                onload: function(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.response);
                    } else {
                        reject(new Error('HTTP ' + resp.status));
                    }
                },
                onerror: function(err) { reject(new Error(err.error || '下載失敗')); },
                ontimeout: function() { reject(new Error('下載超時')); }
            });
        });
    }

    Promise.all([
        dbGet('dicts', 'kuromoji_download_time'),
        dbGet('dicts', 'jmdict_download_time'),
        checkKuromojiVersion(),
        checkJMdictVersion()
    ]).then(function(results) {
        var kuromojiLocalTime = results[0];
        var jmdictLocalTime = results[1];
        var kuromojiRemoteTime = results[2];
        var jmdictRemoteTime = results[3];

        var needKuromoji = !kuromojiLocalTime || (kuromojiRemoteTime && kuromojiRemoteTime > kuromojiLocalTime);
        var needJMdict = !jmdictLocalTime || (jmdictRemoteTime && jmdictRemoteTime > jmdictLocalTime);

        _log('[UpdateDict] Kuromoji 需要更新:', needKuromoji, '| JMdict 需要更新:', needJMdict);

        if (!needKuromoji && !needJMdict) {
            _log('[UpdateDict] 所有字典均為最新，無需更新');
            btn.textContent = '已是最新 ✓';
            setTimeout(function() { btn.textContent = 'Update Dict'; btn.disabled = false; }, 2000);
            return Promise.resolve();
        }

        var chain = Promise.resolve();

        if (needKuromoji) {
            chain = chain.then(function() {
                _log('[UpdateDict] 開始更新 Kuromoji 字典...');
                return KUROMOJI_FILES.reduce(function(fileChain, fileName, idx) {
                    return fileChain.then(function() {
                        _log('[UpdateDict] Kuromoji 下載中: ' + fileName + ' (' + (idx + 1) + '/' + KUROMOJI_FILES.length + ')');
                        return downloadKuromojiFile(fileName).then(function(buffer) {
                            return dbSet('dicts', fileName, buffer);
                        });
                    });
                }, Promise.resolve());
            }).then(function() {
                var now = Date.now();
                return dbSet('dicts', 'kuromoji_download_time', now).then(function() {
                    _log('[UpdateDict] Kuromoji 更新完成，時間戳:', new Date(now).toLocaleString());
                });
            }).catch(function(err) {
                _error('[UpdateDict] Kuromoji 更新失敗:', err.message || err);
            });
        }

        if (needJMdict) {
            chain = chain.then(function() {
                _log('[UpdateDict] 開始下載 JMdict...');
                return downloadJMdictFull();
            }).then(function(buffer) {
                _log('[UpdateDict] JMdict 下載完成，開始解壓...');
                var _origSetImmediate = typeof setImmediate !== 'undefined' ? setImmediate : null;
                if (_origSetImmediate) { setImmediate = function(fn) { setTimeout(fn, 0); }; }
                return JSZip.loadAsync(buffer).then(function(zip) {
                    var jsonFiles = [];
                    zip.forEach(function(path, entry) {
                        if (!entry.dir && path.indexOf('term_bank_') !== -1 && path.slice(-5) === '.json') {
                            jsonFiles.push(entry);
                        }
                    });
                    var total = jsonFiles.length;
                    _log('[UpdateDict] JMdict 找到', total, '個 term_bank 文件，開始解析...');
                    var allEntries = [];
                    return jsonFiles.reduce(function(zipChain, entry, idx) {
                        return zipChain.then(function() {
                            _log('[UpdateDict] JMdict 解析中: ' + (idx + 1) + '/' + total);
                              return entry.async('string').then(function(text) {
                                  try {
                                      var arr = JSON.parse(text);
                                      arr.forEach(function(item) {
                                          if (Array.isArray(item) && item.length >= 6) {
                                              var expression = item[0];
                                              var reading = item[1];
                                              var glossaryRaw = item[5];
                                              var glossary = [];
                                              if (Array.isArray(glossaryRaw)) {
                                                  glossaryRaw.forEach(function(g) {
                                                      if (typeof g === 'string') glossary.push(g);
                                                      else if (g && typeof g.text === 'string') glossary.push(g.text);
                                                  });
                                              }
                                              if (expression && glossary.length > 0) {
                                                  allEntries.push({ expression: expression, reading: reading, glossary: glossary });
                                              }
                                          }
                                      });
                                  } catch(e) { _error('[UpdateDict] JMdict JSON 解析失敗:', e.message); }
                            }).catch(function(err) {
                                _error('[UpdateDict] JMdict 文件解壓失敗:', err.message || err);
                            });
                        });
                    }, Promise.resolve()).then(function() {
                    if (_origSetImmediate) { setImmediate = _origSetImmediate; }
                    return allEntries;
                    });
                });
            }).then(function(allEntries) {
                _log('[UpdateDict] JMdict 儲存中，共', allEntries.length, '條條目...');
                return dbSet('dicts', 'jmdict_data', allEntries).then(function() {
                    var now = Date.now();
                    return dbSet('dicts', 'jmdict_download_time', now).then(function() {
                        _log('[UpdateDict] JMdict 更新完成，時間戳:', new Date(now).toLocaleString());
                    });
                });
            }).catch(function(err) {
                _error('[UpdateDict] JMdict 更新失敗:', err.message || err);
            });
        }

        return chain;
    }).then(function() {
        _log('[UpdateDict] 所有字典更新完成');
        btn.textContent = '更新完成 ✓';
          btn.textContent = '更新完成 ✓';
          dbGet('dicts', 'jmdict_data').then(function(data) {
              if (data && Array.isArray(data)) {
                  var index = {};
                  data.forEach(function(entry) {
                      if (entry.reading) {
                          var hira = entry.reading.replace(/[ァ-ン]/g, function(c) {
                              return String.fromCharCode(c.charCodeAt(0) - 0x60);
                          });
                          if (!index[entry.reading]) index[entry.reading] = [];
                          index[entry.reading].push(entry);
                          if (hira !== entry.reading) {
                              if (!index[hira]) index[hira] = [];
                              index[hira].push(entry);
                          }
                      }
                  });
                  dbSet('dicts', 'jmdict_reading_index', index).then(function() {
                      _log('[UpdateDict] JMdict reading 索引建立完成，共', Object.keys(index).length, '個讀音');
                  });
              }
          });
        setTimeout(function() { btn.textContent = 'Update Dict'; btn.disabled = false; }, 2000);
        renderKuromojiItems();
        renderJMdictItems();
    }).catch(function(err) {
        _error('[UpdateDict] 更新過程發生錯誤:', err.message || err);
        btn.textContent = '更新失敗';
        setTimeout(function() { btn.textContent = 'Update Dict'; btn.disabled = false; }, 2000);
    });
}

function renderNav() {
    navList.innerHTML = '';
    navList.appendChild(makeGroupHeader('本地字典', 'local'));
    if (groupStates.local) {
        var emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'font-size: 8.5pt; padding: 4px 8px 4px 20px; color: #999; border-bottom: 1px solid rgba(92,13,18,0.1);';
        emptyMsg.textContent = '（無本地字典）';
        navList.appendChild(emptyMsg);
    }
    navList.appendChild(makeGroupHeader('外部字典', 'external'));
    if (groupStates.external) {
        navList.appendChild(makeSubGroupHeader('Kuromoji', 'kuromoji'));
        if (groupStates.kuromoji) {
            navList.appendChild(kuromojiItemsDiv);
            if (kuromojiItemsDiv.children.length === 0) renderKuromojiItems();
        }
        navList.appendChild(makeSubGroupHeader('JMdict', 'jmdict'));
        if (groupStates.jmdict) {
            navList.appendChild(jmdictItemsDiv);
            if (jmdictItemsDiv.children.length === 0) renderJMdictItems();
        }
    }
}

function downloadJMdict(btn, onComplete) {
    var JMDICT_URL = 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english.zip';
    btn.disabled = true;
    btn.textContent = '下載中...';
    _log('[JMdict] 開始下載...');
    var startTime = Date.now();
    var progressInterval = setInterval(function() {
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        _log('[JMdict] 下載進行中... 已耗時 ' + elapsed + ' 秒');
    }, 5000);
    GM_xmlhttpRequest({
        method: 'GET',
        url: JMDICT_URL,
        responseType: 'arraybuffer',
        anonymous: true,
        redirect: 'follow',
        onload: function(resp) {
            clearInterval(progressInterval);
            if (resp.status < 200 || resp.status >= 300) {
                _error('[JMdict] 下載失敗 HTTP:', resp.status);
                btn.textContent = '下載失敗'; btn.disabled = false; return;
            }
            _log('[JMdict] 下載完成，大小:', resp.response.byteLength, '位元組');
            btn.textContent = '解壓中...';
            try {
                JSZip.loadAsync(resp.response).then(function(zip) {
                    var jsonFiles = [];
                    zip.forEach(function(path, entry) {
                        if (!entry.dir && path.indexOf('term_bank_') !== -1 && path.slice(-5) === '.json') {
                            jsonFiles.push(entry);
                        }
                    });
                    var total = jsonFiles.length;
                    _log('[JMdict] 找到', total, '個 term_bank JSON 文件');
                    var allEntries = [];
                    function processNext(idx) {
                        if (idx >= total) {
                            _log('[JMdict] 解析完成，共', allEntries.length, '條條目，儲存中...');
                            btn.textContent = '儲存中...';
                            return dbSet('dicts', 'jmdict_data', allEntries).then(function() {
                                _log('[JMdict] 儲存完成');
                                btn.textContent = '下載完成 ✓';
                                setTimeout(function() { btn.textContent = '重新下載'; btn.disabled = false; }, 2000);
                                if (onComplete) onComplete();
                  dbGet('dicts', 'jmdict_data').then(function(data) {
                      if (data && Array.isArray(data)) {
                          var index = {};
                          data.forEach(function(entry) {
                              if (entry.reading) {
                                  var hira = entry.reading.replace(/[ァ-ン]/g, function(c) {
                                      return String.fromCharCode(c.charCodeAt(0) - 0x60);
                                  });
                                  if (!index[entry.reading]) index[entry.reading] = [];
                                  index[entry.reading].push(entry);
                                  if (hira !== entry.reading) {
                                      if (!index[hira]) index[hira] = [];
                                      index[hira].push(entry);
                                  }
                              }
                          });
                          dbSet('dicts', 'jmdict_reading_index', index).then(function() {
                              _log('[JMdict] reading 索引建立完成，共', Object.keys(index).length, '個讀音');
                              if (onComplete) onComplete();
                          });
                      } else {
                          if (onComplete) onComplete();
                      }
                  });
                            }).catch(function(err) {
                                _error('[JMdict] 儲存失敗:', err.message || err);
                                btn.textContent = '儲存失敗'; btn.disabled = false;
                            });
                        }
                        btn.textContent = '處理 ' + (idx + 1) + '/' + total;
                          return jsonFiles[idx].async('string').then(function(text) {
                              try {
                                  var arr = JSON.parse(text);
                                  arr.forEach(function(item) {
                                      if (Array.isArray(item) && item.length >= 6) {
                                          var expression = item[0];
                                          var reading = item[1];
                                          var glossaryRaw = item[5];
                                          var glossary = [];
                                          if (Array.isArray(glossaryRaw)) {
                                              glossaryRaw.forEach(function(g) {
                                                  if (typeof g === 'string') glossary.push(g);
                                                  else if (g && typeof g.text === 'string') glossary.push(g.text);
                                              });
                                          }
                                          if (expression && glossary.length > 0) {
                                              allEntries.push({ expression: expression, reading: reading, glossary: glossary });
                                          }
                                      }
                                  });
                              } catch(parseErr) {
                                _error('[JMdict] JSON 解析失敗 ' + (idx + 1) + '/' + total + ':', parseErr.message);
                            }
                            return processNext(idx + 1);
                        }).catch(function(err) {
                            _error('[JMdict] 文件解壓失敗 ' + (idx + 1) + '/' + total + ':', err.message || err);
                            return processNext(idx + 1);
                        });
                    }
                    processNext(0);
                }).catch(function(err) {
                    _error('[JMdict] ZIP 解壓失敗:', err.message || err);
                    btn.textContent = '解壓失敗'; btn.disabled = false;
                });
            } catch(e) {
                _error('[JMdict] 解壓過程發生例外:', e.message || e);
                btn.textContent = '解壓失敗'; btn.disabled = false;
            }
        },
        onerror: function(err) {
            clearInterval(progressInterval);
            _error('[JMdict] 請求錯誤:', JSON.stringify(err));
            btn.textContent = '下載失敗'; btn.disabled = false;
        },
        ontimeout: function() {
            clearInterval(progressInterval);
            _error('[JMdict] 下載超時');
            btn.textContent = '下載超時'; btn.disabled = false;
        }
    });
}

leftCol.appendChild(navList);
renderNav();
return container;
}

// ==================== createConsolePanel ====================

function createConsolePanel() {
var container = document.createElement('div');
container.className = 'console-panel-container';
container.style.cssText = 'display: none; padding: 10px; background-color: #E3E0D1; border: 1px solid #5C0D12; position: relative;';

var title = document.createElement('div');
title.textContent = 'Console';
title.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
container.appendChild(title);

var logContainer = document.createElement('div');
logContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 8.5pt; padding: 4px;';
container.appendChild(logContainer);

var bottomRow = document.createElement('div');
bottomRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;';

var clearBtn = document.createElement('button');
clearBtn.textContent = 'Clear';
clearBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 16px; cursor: pointer; border-radius: 3px; height: 24px;';
clearBtn.addEventListener('click', function(e) {
e.preventDefault();
while (logContainer.firstChild) logContainer.removeChild(logContainer.firstChild);
_consoleLog.length = 0;
});
bottomRow.appendChild(clearBtn);
container.appendChild(bottomRow);

function addEntry(time, level, msg) {
var row = document.createElement('div');
var color = level === 'ERROR' ? '#CC0000' : level === 'WARN' ? '#CC6600' : '#333333';
row.style.cssText = 'padding: 1px 2px; border-bottom: 1px solid rgba(92,13,18,0.1); color: ' + color + '; word-break: break-all; line-height: 1.5;';
row.textContent = '[' + time + '] [' + level + '] ' + msg;
logContainer.appendChild(row);
logContainer.scrollTop = logContainer.scrollHeight;
}

_consoleLog.forEach(function(entry) { addEntry(entry.time, entry.level, entry.msg); });

container.addEntry = addEntry;
_consolePanel = container;

container.addEventListener('show', function() {
logContainer.scrollTop = logContainer.scrollHeight;
});

return container;
}

// ==================== createCommentTemplatePanel ====================

function createCommentTemplatePanel() {
var container = document.createElement('div');
container.className = 'comment-template-container';
container.style.cssText = 'display: none; padding: 10px; background-color: #E0DED3; border: 1px solid #5C0D12; position: relative;';

var title = document.createElement('div');
title.textContent = 'Comment Template';
title.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
container.appendChild(title);

var body = document.createElement('div');
body.style.cssText = 'display: flex; gap: 0; min-height: 180px;';

var leftCol = document.createElement('div');
leftCol.style.cssText = 'width: 180px; flex-shrink: 0; border: 1px solid #5C0D12; background-color: #E0DED3; display: flex; flex-direction: column;';

var listBox = document.createElement('div');
listBox.style.cssText = 'flex: 1; overflow-y: auto; border-bottom: 1px solid #5C0D12;';

var leftBtnRow = document.createElement('div');
leftBtnRow.style.cssText = 'display: flex; gap: 4px; padding: 4px; background-color: #E0DED3;';

var btnNewTpl = document.createElement('button');
btnNewTpl.textContent = '新增';
btnNewTpl.style.cssText = 'flex: 1; background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; cursor: pointer; border-radius: 3px; height: 22px;';

var btnDelTpl = document.createElement('button');
btnDelTpl.textContent = '刪除';
btnDelTpl.style.cssText = 'flex: 1; background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; cursor: pointer; border-radius: 3px; height: 22px;';

leftBtnRow.appendChild(btnNewTpl);
leftBtnRow.appendChild(btnDelTpl);
leftCol.appendChild(listBox);
leftCol.appendChild(leftBtnRow);

var rightCol = document.createElement('div');
rightCol.style.cssText = 'flex: 1; border: 1px solid #5C0D12; border-left: none; background-color: #E0DED3; display: flex; flex-direction: column; padding: 8px; gap: 6px; box-sizing: border-box;';

var nameRow = document.createElement('div');
nameRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
var nameLabel = document.createElement('span');
nameLabel.textContent = '名稱:';
nameLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; color: #5C0D12; font-weight: bold;';
var nameInput = document.createElement('input');
nameInput.type = 'text';
nameInput.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px; box-sizing: border-box;';
nameRow.appendChild(nameLabel);
nameRow.appendChild(nameInput);

var contentLabel = document.createElement('span');
contentLabel.textContent = '內容:';
contentLabel.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold;';

var contentTextarea = document.createElement('textarea');
contentTextarea.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 4px; resize: none; font-family: inherit; box-sizing: border-box; min-height: 80px;';

var rightBtnRow = document.createElement('div');
rightBtnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px;';

var btnSaveTpl = document.createElement('button');
btnSaveTpl.textContent = '儲存';
btnSaveTpl.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 2px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; height: 22px;';

var btnCancelTpl = document.createElement('button');
btnCancelTpl.textContent = '取消';
btnCancelTpl.style.cssText = 'background-color: #E0DED3; color: #5C0D12; border: 1px solid #5C0D12; border-radius: 3px; padding: 2px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; height: 22px;';

rightBtnRow.appendChild(btnSaveTpl);
rightBtnRow.appendChild(btnCancelTpl);
rightCol.appendChild(nameRow);
rightCol.appendChild(contentLabel);
rightCol.appendChild(contentTextarea);
rightCol.appendChild(rightBtnRow);

body.appendChild(leftCol);
body.appendChild(rightCol);
container.appendChild(body);

var selectedId = null;
var isNew = false;

function getTemplates() { try { var v = GM_getValue('comment_templates', []); return Array.isArray(v) ? v : []; } catch(e) { return []; } }
function saveTemplates(arr) { try { GM_setValue('comment_templates', arr); } catch(e) { _error('[CommentTemplate] 保存失敗:', e); } }

function syncAllGroupDropdowns() {
var selects = document.querySelectorAll('select.comment-template-select');
var templates = getTemplates();
selects.forEach(function(sel) {
var currentVal = sel.value;
while (sel.options.length > 0) sel.remove(0);
var noneOpt = document.createElement('option');
noneOpt.value = '';
noneOpt.textContent = '----------None----------';
sel.appendChild(noneOpt);
templates.forEach(function(tpl) {
var opt = document.createElement('option');
opt.value = tpl.id;
opt.textContent = tpl.name;
sel.appendChild(opt);
});
var stillExists = templates.some(function(t) { return t.id === currentVal; });
sel.value = stillExists ? currentVal : '';
});
}

function renderList() {
while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
var templates = getTemplates();
templates.forEach(function(tpl) {
var item = document.createElement('div');
item.style.cssText = 'padding: 5px 8px; font-size: 9pt; cursor: pointer; border-bottom: 1px solid #D0CEC3; word-break: break-all; background-color: #E0DED3;';
item.textContent = tpl.name || '(無名稱)';
item.dataset.id = tpl.id;
if (tpl.id === selectedId) { item.style.backgroundColor = '#5C0D12'; item.style.color = '#FFFFFF'; }
item.addEventListener('click', function() { selectedId = tpl.id; isNew = false; nameInput.value = tpl.name; contentTextarea.value = tpl.content; renderList(); });
listBox.appendChild(item);
});
}

function clearRight() { nameInput.value = ''; contentTextarea.value = ''; selectedId = null; isNew = false; renderList(); }

btnNewTpl.addEventListener('click', function(e) { e.preventDefault(); selectedId = null; isNew = true; nameInput.value = ''; contentTextarea.value = ''; renderList(); nameInput.focus(); });
btnDelTpl.addEventListener('click', function(e) { e.preventDefault(); if (!selectedId) return; var templates = getTemplates(); saveTemplates(templates.filter(function(t) { return t.id !== selectedId; })); clearRight(); syncAllGroupDropdowns(); });
btnSaveTpl.addEventListener('click', function(e) {
e.preventDefault();
var name = nameInput.value.trim();
if (!name) { nameInput.focus(); return; }
var content = contentTextarea.value;
var templates = getTemplates();
if (isNew || !selectedId) {
var newId = 'tpl_' + Date.now();
templates.push({ id: newId, name: name, content: content });
selectedId = newId; isNew = false;
} else {
templates = templates.map(function(t) { return t.id === selectedId ? { id: t.id, name: name, content: content } : t; });
}
saveTemplates(templates); renderList(); syncAllGroupDropdowns();
btnSaveTpl.textContent = '已儲存 ✓';
setTimeout(function() { btnSaveTpl.textContent = '儲存'; }, 1500);
});
btnCancelTpl.addEventListener('click', function(e) { e.preventDefault(); clearRight(); });

renderList();
return container;
}

// ==================== createShowFileListPanel ====================

function createShowFileListPanel() {
var container = document.createElement('div');
container.className = 'show-file-list-container';
container.style.cssText = 'display: none; padding: 10px; background-color: #E3E0D1; border: 1px solid #5C0D12; position: relative;';

var firstOpen = true;
var currentSubPanel = 'filelist';

var title = document.createElement('div');
title.textContent = 'Gallery Folder Manager';
title.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
container.appendChild(title);

var topRow = document.createElement('div');
topRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

var galleryLabel = document.createElement('span');
galleryLabel.textContent = '圖庫:';
galleryLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; font-weight: bold; color: #5C0D12; flex-shrink: 0;';
topRow.appendChild(galleryLabel);

var gallerySelect = document.createElement('select');
applySelectStyle(gallerySelect, '300px');
gallerySelect.style.flexShrink = '0';
topRow.appendChild(gallerySelect);

var topSpacer = document.createElement('div');
topSpacer.style.cssText = 'flex: 1;';
topRow.appendChild(topSpacer);

var sortingLabel = document.createElement('span');
sortingLabel.textContent = 'Sorting Method:';
sortingLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; color: #5C0D12; font-weight: bold;';
topRow.appendChild(sortingLabel);

var sortingSelect = document.createElement('select');
applySelectStyle(sortingSelect, '90px');
sortingSelect.style.flexShrink = '0';
var sortNatural = document.createElement('option'); sortNatural.value = 'natural'; sortNatural.textContent = '自然排序'; sortingSelect.appendChild(sortNatural);
var sortLexical = document.createElement('option'); sortLexical.value = 'lexical'; sortLexical.textContent = '詞典序排序'; sortingSelect.appendChild(sortLexical);
topRow.appendChild(sortingSelect);

var sortGoBtn = document.createElement('button');
sortGoBtn.textContent = 'GO';
sortGoBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; line-height: 18px; box-sizing: border-box; flex-shrink: 0;';
topRow.appendChild(sortGoBtn);

var galleryFileLabel = document.createElement('span');
galleryFileLabel.textContent = 'Gallery File:';
galleryFileLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; color: #5C0D12; font-weight: bold; margin-left: 8px;';
topRow.appendChild(galleryFileLabel);

var actionSelect = document.createElement('select');
applySelectStyle(actionSelect, '70px');
actionSelect.style.flexShrink = '0';
var delOpt = document.createElement('option'); delOpt.value = 'delete'; delOpt.textContent = 'Delete'; actionSelect.appendChild(delOpt);
topRow.appendChild(actionSelect);

var actionGoBtn = document.createElement('button');
actionGoBtn.textContent = 'GO';
actionGoBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; line-height: 18px; box-sizing: border-box; flex-shrink: 0;';
topRow.appendChild(actionGoBtn);
container.appendChild(topRow);

var tabRow = document.createElement('div');
tabRow.style.cssText = 'display: flex; gap: 0; margin-bottom: 8px; border-bottom: 1px solid #5C0D12;';

var fileListTab = document.createElement('button');
fileListTab.textContent = 'Show File List';
fileListTab.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0;';

var folderManagerTab = document.createElement('button');
folderManagerTab.textContent = 'Folder Manager';
folderManagerTab.style.cssText = 'background-color: #E3E0D1; color: #5C0D12; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0; margin-left: 4px;';

var fileRenamerTab = document.createElement('button');
fileRenamerTab.textContent = 'File Renamer';
fileRenamerTab.style.cssText = 'background-color: #E3E0D1; color: #5C0D12; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0; margin-left: 4px;';

tabRow.appendChild(fileListTab);
tabRow.appendChild(folderManagerTab);
tabRow.appendChild(fileRenamerTab);
container.appendChild(tabRow);

// ── Show File List 子面板 ──
var fileListPanel = document.createElement('div');
fileListPanel.style.cssText = 'display: block;';

var fileListTopRow = document.createElement('div');
fileListTopRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
var sortAscBtn = document.createElement('button');
sortAscBtn.textContent = '升序 ↑';
sortAscBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 10px; cursor: pointer; border-radius: 3px; height: 22px;';
var sortDescBtn = document.createElement('button');
sortDescBtn.textContent = '降序 ↓';
sortDescBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 10px; cursor: pointer; border-radius: 3px; height: 22px;';
var fileListSpacer = document.createElement('div'); fileListSpacer.style.cssText = 'flex: 1;';
var selectAllBtn = document.createElement('button');
selectAllBtn.textContent = '全選';
selectAllBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 10px; cursor: pointer; border-radius: 3px; height: 22px;';
var deselectAllBtn = document.createElement('button');
deselectAllBtn.textContent = '取消全選';
deselectAllBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 10px; cursor: pointer; border-radius: 3px; height: 22px;';
selectAllBtn.addEventListener('click', function(e) { e.preventDefault(); listContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = true; }); });
deselectAllBtn.addEventListener('click', function(e) { e.preventDefault(); listContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = false; }); });
fileListTopRow.appendChild(sortAscBtn);
fileListTopRow.appendChild(sortDescBtn);
fileListTopRow.appendChild(fileListSpacer);
fileListTopRow.appendChild(selectAllBtn);
fileListTopRow.appendChild(deselectAllBtn);
fileListPanel.appendChild(fileListTopRow);

var listContainer = document.createElement('div');
listContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
fileListPanel.appendChild(listContainer);

var fileListBottomRow = document.createElement('div');
fileListBottomRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 8px;';
var saveOrderBtn = document.createElement('button');
saveOrderBtn.textContent = 'Save Order';
saveOrderBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
fileListBottomRow.appendChild(saveOrderBtn);
fileListPanel.appendChild(fileListBottomRow);
container.appendChild(fileListPanel);

// ── Folder Manager 子面板 ──
var folderManagerPanel = document.createElement('div');
folderManagerPanel.style.cssText = 'display: none;';

var folderListContainer = document.createElement('div');
folderListContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
folderManagerPanel.appendChild(folderListContainer);

var folderBottomRow = document.createElement('div');
folderBottomRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 8px;';
var saveFolderBtn = document.createElement('button');
saveFolderBtn.textContent = 'Save';
saveFolderBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
folderBottomRow.appendChild(saveFolderBtn);
folderManagerPanel.appendChild(folderBottomRow);
container.appendChild(folderManagerPanel);

// ── File Renamer 子面板 ──
var fileRenamerPanel = document.createElement('div');
fileRenamerPanel.style.cssText = 'display: none;';

var renamerControlsDiv = document.createElement('div');
renamerControlsDiv.style.cssText = 'background-color: rgb(227,224,209); border: 1px solid #5C0D12; padding: 8px; margin-bottom: 6px;';

var seqRow = document.createElement('div');
seqRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap;';
var seqLabel = document.createElement('span'); seqLabel.textContent = '序號重命名:'; seqLabel.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; white-space: nowrap; flex-shrink: 0;';
var prefixInput = document.createElement('input'); prefixInput.type = 'text'; prefixInput.placeholder = '前綴'; prefixInput.style.cssText = 'width: 70px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var startNumInput = document.createElement('input'); startNumInput.type = 'number'; startNumInput.placeholder = '起始號'; startNumInput.value = ''; startNumInput.style.cssText = 'width: 60px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var paddingInput = document.createElement('input'); paddingInput.type = 'number'; paddingInput.placeholder = '位數'; paddingInput.value = ''; paddingInput.style.cssText = 'width: 50px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var suffixInput = document.createElement('input'); suffixInput.type = 'text'; suffixInput.placeholder = '後綴'; suffixInput.style.cssText = 'width: 70px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var seqApplyChecked = document.createElement('button'); seqApplyChecked.textContent = '套用勾選'; seqApplyChecked.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; white-space: nowrap;';
var seqApplyAll = document.createElement('button'); seqApplyAll.textContent = '套用全部'; seqApplyAll.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; white-space: nowrap;';
var seqHelpBtn = document.createElement('button'); seqHelpBtn.textContent = '[?]'; seqHelpBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 6px; cursor: pointer; border-radius: 3px; height: 20px; white-space: nowrap;';
seqHelpBtn.addEventListener('click', function(e) {
e.preventDefault();
var helpText = '序號重命名說明\n\n前綴：加在序號前方的文字\n起始號：序號從此數字開始（空白則從 1 開始）\n位數：序號補零至指定位數（空白則不補零）\n後綴：加在序號後方的文字\n\n範例：\n前綴=img_ 起始號=1 位數=3 後綴=（空）\n→ img_001.jpg, img_002.jpg, img_003.jpg\n\n前綴=（空）起始號=5 位數=（空）後綴=_pic\n→ 5_pic.jpg, 6_pic.jpg, 7_pic.jpg\n\n前綴=ch1_ 起始號=（空）位數=（空）後綴=（空）\n→ ch1_1.jpg, ch1_2.jpg, ch1_3.jpg';
alert(helpText);
});
seqRow.appendChild(seqLabel); seqRow.appendChild(prefixInput); seqRow.appendChild(startNumInput); seqRow.appendChild(paddingInput); seqRow.appendChild(suffixInput); seqRow.appendChild(seqApplyChecked); seqRow.appendChild(seqApplyAll); seqRow.appendChild(seqHelpBtn);
renamerControlsDiv.appendChild(seqRow);

var replaceRow = document.createElement('div');
replaceRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;';
var replaceLabel = document.createElement('span'); replaceLabel.textContent = '搜索替換:'; replaceLabel.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; white-space: nowrap; flex-shrink: 0;';
var searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.placeholder = '搜索'; searchInput.style.cssText = 'width: 120px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var replaceInput = document.createElement('input'); replaceInput.type = 'text'; replaceInput.placeholder = '替換為'; replaceInput.style.cssText = 'width: 120px; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
var regexLabel = document.createElement('label'); regexLabel.style.cssText = 'display: inline-flex; align-items: center; gap: 3px; font-size: 9pt; white-space: nowrap;';
var regexCb = document.createElement('input'); regexCb.type = 'checkbox'; regexCb.style.cssText = 'accent-color: #5C0D12;';
regexLabel.appendChild(regexCb); regexLabel.appendChild(document.createTextNode('正則'));
var replaceApplyChecked = document.createElement('button'); replaceApplyChecked.textContent = '套用勾選'; replaceApplyChecked.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; white-space: nowrap;';
var replaceApplyAll = document.createElement('button'); replaceApplyAll.textContent = '套用全部'; replaceApplyAll.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 8px; cursor: pointer; border-radius: 3px; height: 20px; white-space: nowrap;';
replaceRow.appendChild(replaceLabel); replaceRow.appendChild(searchInput); replaceRow.appendChild(replaceInput); replaceRow.appendChild(regexLabel); replaceRow.appendChild(replaceApplyChecked); replaceRow.appendChild(replaceApplyAll);
renamerControlsDiv.appendChild(replaceRow);
fileRenamerPanel.appendChild(renamerControlsDiv);

var renamerListContainer = document.createElement('div');
renamerListContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
fileRenamerPanel.appendChild(renamerListContainer);

var renamerSnapshot = null;
var renamerBottomRow = document.createElement('div');
renamerBottomRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 8px; gap: 8px;';
var cancelRenameBtn = document.createElement('button');
cancelRenameBtn.textContent = '取消';
cancelRenameBtn.style.cssText = 'background-color: #E0DED3; color: #5C0D12; border: 1px solid #5C0D12; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
cancelRenameBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!renamerSnapshot) return;
currentFiles = renamerSnapshot.map(function(f) { return Object.assign({}, f); });
renderRenamerList();
});
var saveRenameBtn = document.createElement('button');
saveRenameBtn.textContent = 'Save';
saveRenameBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
renamerBottomRow.appendChild(cancelRenameBtn);
renamerBottomRow.appendChild(saveRenameBtn);
fileRenamerPanel.appendChild(renamerBottomRow);
container.appendChild(fileRenamerPanel);

var currentFiles = [];
var currentGalleryId = null;
var dragSrcIndex = null;

function switchTab(tab) {
currentSubPanel = tab;
var tabs = [
{ el: fileListTab, panel: fileListPanel, name: 'filelist' },
{ el: folderManagerTab, panel: folderManagerPanel, name: 'foldermanager' },
{ el: fileRenamerTab, panel: fileRenamerPanel, name: 'filerename' }
];
tabs.forEach(function(t) {
var active = t.name === tab;
t.el.style.backgroundColor = active ? '#5C0D12' : '#E3E0D1';
t.el.style.color = active ? '#FFFFFF' : '#5C0D12';
t.panel.style.display = active ? 'block' : 'none';
});
if (tab === 'foldermanager') renderFolderManager();
if (tab === 'filerename') renderRenamerList();
}

fileListTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('filelist'); });
folderManagerTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('foldermanager'); });
fileRenamerTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('filerename'); });

function renderFileList() {
while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
if (currentFiles.length === 0) {
var emptyMsg = document.createElement('div');
emptyMsg.textContent = '無文件';
emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
listContainer.appendChild(emptyMsg);
return;
}
currentFiles.forEach(function(file, index) {
var row = document.createElement('div');
row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209); cursor: grab;';
row.draggable = true;

row.addEventListener('dragstart', function(e) { dragSrcIndex = index; e.dataTransfer.effectAllowed = 'move'; row.style.opacity = '0.4'; });
row.addEventListener('dragend', function() { row.style.opacity = '1'; listContainer.querySelectorAll('div[draggable]').forEach(function(r) { r.style.borderTop = ''; }); });
row.addEventListener('dragover', function(e) { e.preventDefault(); listContainer.querySelectorAll('div[draggable]').forEach(function(r) { r.style.borderTop = ''; }); row.style.borderTop = '2px solid #5C0D12'; });
row.addEventListener('drop', function(e) { e.preventDefault(); if (dragSrcIndex === null || dragSrcIndex === index) return; var moved = currentFiles.splice(dragSrcIndex, 1)[0]; currentFiles.splice(index, 0, moved); dragSrcIndex = null; renderFileList(); });

var checkBox = document.createElement('input'); checkBox.type = 'checkbox'; checkBox.style.cssText = 'margin: 0; flex-shrink: 0; accent-color: #5C0D12;';
row.appendChild(checkBox);

var numSpan = document.createElement('span'); numSpan.textContent = (index + 1) + '.'; numSpan.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold; min-width: 30px; flex-shrink: 0;';
row.appendChild(numSpan);

var nameSpan = document.createElement('span'); nameSpan.textContent = file.name || file.path; nameSpan.style.cssText = 'font-size: 9pt; flex: 1; word-break: break-all;';
row.appendChild(nameSpan);

var previewBtn = document.createElement('button');
previewBtn.textContent = '預覧';
previewBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 36px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
(function(f, btn) {
btn.addEventListener('click', function(e) {
e.preventDefault();
e.stopPropagation();
var existingOverlay = document.getElementById('file-preview-overlay');
var existingActiveBtn = document.querySelector('.preview-btn-active');
if (existingActiveBtn && existingActiveBtn !== btn) {
existingActiveBtn.style.backgroundColor = '#E0DED3';
existingActiveBtn.style.color = '#5C0D12';
existingActiveBtn.style.borderColor = '#5C0D12';
existingActiveBtn.classList.remove('preview-btn-active');
}
if (existingOverlay) { existingOverlay.remove(); }
btn.style.backgroundColor = '#5C0D12';
btn.style.color = '#FFFFFF';
btn.style.borderColor = '#5C0D12';
btn.classList.add('preview-btn-active');
var fileLists = {};
try { fileLists = GM_getValue('file_lists', {}); } catch(err) {}
var fileListData = currentGalleryId ? fileLists[currentGalleryId] : null;
var folderName = (fileListData && !Array.isArray(fileListData) && fileListData.folderName) ? fileListData.folderName : null;
if (!folderName) {
_log('[Preview] ZIP 來源檔案無法預覧:', f.name || f.path);
btn.style.backgroundColor = '#CC0000';
btn.style.color = '#FFFFFF';
btn.style.borderColor = '#CC0000';
return;
}
var maxW = currentSettings.previewMaxWidth || 800;
var maxH = currentSettings.previewMaxHeight || 800;
dbGet('handles', 'root_folder_handle').then(function(rootHandle) {
if (!rootHandle) { _log('[Preview] 無 root_folder_handle'); btn.style.backgroundColor = '#CC0000'; btn.style.color = '#FFFFFF'; btn.style.borderColor = '#CC0000'; return; }
return rootHandle.requestPermission({ mode: 'read' }).then(function(perm) {
if (perm !== 'granted') { _log('[Preview] 無讀取權限'); btn.style.backgroundColor = '#CC0000'; btn.style.color = '#FFFFFF'; btn.style.borderColor = '#CC0000'; return; }
return rootHandle.getDirectoryHandle(folderName).then(function(folderHandle) {
var parts = (f.path || f.name || '').split('/');
function resolveHandle(handle, parts) {
if (parts.length === 1) return handle.getFileHandle(parts[0]).then(function(fh) { return fh.getFile(); });
return handle.getDirectoryHandle(parts[0]).then(function(dh) { return resolveHandle(dh, parts.slice(1)); });
}
return resolveHandle(folderHandle, parts).then(function(fileObj) {
var url = URL.createObjectURL(fileObj);
var overlay = document.createElement('div');
overlay.id = 'file-preview-overlay';
overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); z-index: 99999; display: flex; align-items: center; justify-content: center;';
var imgBox = document.createElement('div');
imgBox.style.cssText = 'background: #1a1a1a; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: ' + maxW + 'px;';
var img = document.createElement('img');
img.src = url;
img.style.cssText = 'max-width: ' + maxW + 'px; max-height: ' + maxH + 'px; object-fit: contain; border-radius: 3px; display: block;';
img.onerror = function() { _log('[Preview] 圖片載入失敗:', f.name || f.path); };
var labelEl = document.createElement('div');
labelEl.textContent = f.name || f.path;
labelEl.style.cssText = 'font-size: 8pt; color: #ccc; word-break: break-all; text-align: center; max-width: ' + maxW + 'px;';
imgBox.appendChild(img);
imgBox.appendChild(labelEl);
overlay.appendChild(imgBox);
document.body.appendChild(overlay);
function closePreview() {
URL.revokeObjectURL(url);
overlay.remove();
btn.style.backgroundColor = '#E0DED3';
btn.style.color = '#5C0D12';
btn.style.borderColor = '#5C0D12';
btn.classList.remove('preview-btn-active');
document.removeEventListener('keydown', escHandler);
}
function escHandler(e) {
if (e.key === 'Escape') { closePreview(); }
}
document.addEventListener('keydown', escHandler);
overlay.addEventListener('click', function(e) {
if (e.target === overlay) { closePreview(); }
});
}).catch(function(err) { _log('[Preview] 無法解析檔案:', f.path, err.message); });
});
});
}).catch(function(err) { _log('[Preview] 錯誤:', err.name, err.message, err); btn.style.backgroundColor = '#CC0000'; btn.style.color = '#FFFFFF'; btn.style.borderColor = '#CC0000'; });
});
})(file, previewBtn);
row.appendChild(previewBtn);

var posInput = document.createElement('input'); posInput.type = 'number'; posInput.min = '1'; posInput.max = String(currentFiles.length); posInput.value = String(index + 1);
posInput.style.cssText = 'width: 44px; border: 1px solid #5C0D12; background-color: rgb(227,224,209); font-size: 9pt; padding: 0 2px; height: 20px; box-sizing: border-box; flex-shrink: 0; text-align: center;';
posInput.addEventListener('keydown', function(e) {
if (e.key !== 'Enter') return;
var target = parseInt(posInput.value) - 1;
if (isNaN(target) || target < 0 || target >= currentFiles.length || target === index) return;
var moved = currentFiles.splice(index, 1)[0]; currentFiles.splice(target, 0, moved); renderFileList();
});
row.appendChild(posInput);

var upBtn = document.createElement('button'); upBtn.textContent = '↑'; upBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
if (index === 0) { upBtn.style.opacity = '0.3'; upBtn.style.cursor = 'default'; }
upBtn.addEventListener('click', function(e) { e.preventDefault(); if (index === 0) return; var tmp = currentFiles[index]; currentFiles[index] = currentFiles[index-1]; currentFiles[index-1] = tmp; renderFileList(); });
row.appendChild(upBtn);

var downBtn = document.createElement('button'); downBtn.textContent = '↓'; downBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
if (index === currentFiles.length - 1) { downBtn.style.opacity = '0.3'; downBtn.style.cursor = 'default'; }
downBtn.addEventListener('click', function(e) { e.preventDefault(); if (index === currentFiles.length - 1) return; var tmp = currentFiles[index]; currentFiles[index] = currentFiles[index+1]; currentFiles[index+1] = tmp; renderFileList(); });
row.appendChild(downBtn);

var delBtn = document.createElement('button'); delBtn.textContent = '✕'; delBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
delBtn.addEventListener('click', function(e) { e.preventDefault(); currentFiles.splice(index, 1); renderFileList(); if (currentSubPanel === 'foldermanager') renderFolderManager(); if (currentSubPanel === 'filerename') renderRenamerList(); });
row.appendChild(delBtn);
listContainer.appendChild(row);
});
}

function renderFolderManager() {
while (folderListContainer.firstChild) folderListContainer.removeChild(folderListContainer.firstChild);
if (currentFiles.length === 0) {
var emptyMsg = document.createElement('div'); emptyMsg.textContent = '無文件夾'; emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
folderListContainer.appendChild(emptyMsg); return;
}
var folderTree = {};
currentFiles.forEach(function(file) {
var parts = (file.path || file.name || '').split('/');
if (parts.length <= 1) return;
var dirs = parts.slice(0, -1);
var node = folderTree;
dirs.forEach(function(dir) { if (!node[dir]) node[dir] = {}; node = node[dir]; });
});
function renderNode(node, path, depth) {
Object.keys(node).sort(function(a,b){return naturalCompare(a,b);}).forEach(function(key) {
var fullPath = path ? path + '/' + key : key;
var row = document.createElement('div');
row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209);';
var indent = document.createElement('span'); indent.style.cssText = 'display: inline-block; width: ' + (depth * 16) + 'px; flex-shrink: 0;';
row.appendChild(indent);
var nameSpan = document.createElement('span'); nameSpan.textContent = key + '/'; nameSpan.style.cssText = 'font-size: 9pt; flex: 1; color: #333; font-weight: ' + (depth === 0 ? 'bold' : 'normal') + ';';
row.appendChild(nameSpan);
var delBtn = document.createElement('button'); delBtn.textContent = '✕'; delBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
delBtn.addEventListener('click', function(e) {
e.preventDefault();
currentFiles = currentFiles.filter(function(f) { var p = f.path || f.name || ''; return !p.startsWith(fullPath + '/') && p !== fullPath; });
if (currentGalleryId) { var fl = {}; try { fl = GM_getValue('file_lists', {}); } catch(err) {} fl[currentGalleryId] = currentFiles; GM_setValue('file_lists', fl); }
renderFolderManager(); renderFileList(); if (currentSubPanel === 'filerename') renderRenamerList();
});
row.appendChild(delBtn);
folderListContainer.appendChild(row);
renderNode(node[key], fullPath, depth + 1);
});
}
renderNode(folderTree, '', 0);
}

function renderRenamerList() {
while (renamerListContainer.firstChild) renamerListContainer.removeChild(renamerListContainer.firstChild);
if (renamerSnapshot === null && currentFiles.length > 0) {
renamerSnapshot = currentFiles.map(function(f) { return Object.assign({}, f); });
}
if (currentFiles.length === 0) {
var emptyMsg = document.createElement('div'); emptyMsg.textContent = '無文件'; emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
renamerListContainer.appendChild(emptyMsg); return;
}
currentFiles.forEach(function(file, index) {
var row = document.createElement('div');
row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209);';
var checkBox = document.createElement('input'); checkBox.type = 'checkbox'; checkBox.style.cssText = 'margin: 0; flex-shrink: 0; accent-color: #5C0D12;';
row.appendChild(checkBox);
var numSpan = document.createElement('span'); numSpan.textContent = (index + 1) + '.'; numSpan.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold; min-width: 30px; flex-shrink: 0;';
row.appendChild(numSpan);
var nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.value = file.name || file.path;
nameInput.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box;';
nameInput.addEventListener('change', function() { currentFiles[index].name = nameInput.value; });
row.appendChild(nameInput);
renamerListContainer.appendChild(row);
});
}

function applySeqRename(indices) {
var start = startNumInput.value !== '' ? (parseInt(startNumInput.value) || 1) : 1;
var padVal = paddingInput.value !== '' ? parseInt(paddingInput.value) : null;
var prefix = prefixInput.value;
var suffix = suffixInput.value;
var counter = start;
indices.forEach(function(i) {
var file = currentFiles[i];
var ext = (file.name || file.path || '').split('.').pop();
var numStr = String(counter);
if (padVal !== null && padVal > 0) numStr = numStr.padStart(padVal, '0');
file.name = prefix + numStr + suffix + '.' + ext;
counter++;
});
renderRenamerList();
}

function applyReplaceRename(indices) {
var search = searchInput.value;
var replace = replaceInput.value;
if (!search) return;
indices.forEach(function(i) {
var file = currentFiles[i];
var name = file.name || file.path || '';
try {
if (regexCb.checked) {
var re = new RegExp(search, 'g');
file.name = name.replace(re, replace);
} else {
file.name = name.split(search).join(replace);
}
} catch(err) { _error('[Renamer] 正則錯誤:', err.message); }
});
renderRenamerList();
}

seqApplyChecked.addEventListener('click', function(e) {
e.preventDefault();
var checkboxes = renamerListContainer.querySelectorAll('input[type="checkbox"]');
var indices = []; checkboxes.forEach(function(cb, i) { if (cb.checked) indices.push(i); });
applySeqRename(indices);
});
seqApplyAll.addEventListener('click', function(e) {
e.preventDefault();
applySeqRename(currentFiles.map(function(_, i) { return i; }));
});
replaceApplyChecked.addEventListener('click', function(e) {
e.preventDefault();
var checkboxes = renamerListContainer.querySelectorAll('input[type="checkbox"]');
var indices = []; checkboxes.forEach(function(cb, i) { if (cb.checked) indices.push(i); });
applyReplaceRename(indices);
});
replaceApplyAll.addEventListener('click', function(e) {
e.preventDefault();
applyReplaceRename(currentFiles.map(function(_, i) { return i; }));
});

sortAscBtn.addEventListener('click', function(e) {
e.preventDefault();
currentFiles.sort(function(a, b) { return naturalCompare(a.path || a.name || '', b.path || b.name || ''); });
renderFileList();
sortAscBtn.style.backgroundColor = '#5C0D12';
sortAscBtn.style.color = '#FFFFFF';
sortDescBtn.style.backgroundColor = '#E0DED3';
sortDescBtn.style.color = '#5C0D12';
});
sortDescBtn.addEventListener('click', function(e) {
e.preventDefault();
currentFiles.sort(function(a, b) { return naturalCompare(b.path || b.name || '', a.path || a.name || ''); });
renderFileList();
sortDescBtn.style.backgroundColor = '#5C0D12';
sortDescBtn.style.color = '#FFFFFF';
sortAscBtn.style.backgroundColor = '#E0DED3';
sortAscBtn.style.color = '#5C0D12';
});

sortGoBtn.addEventListener('click', function(e) {
e.preventDefault();
var method = sortingSelect.value;
currentFiles.sort(function(a, b) {
var pa = a.path || a.name || '', pb = b.path || b.name || '';
return method === 'natural' ? naturalCompare(pa, pb) : lexicalCompare(pa, pb);
});
renderFileList();
});

actionGoBtn.addEventListener('click', function(e) {
e.preventDefault();
if (actionSelect.value !== 'delete') return;
var checkboxes = listContainer.querySelectorAll('input[type="checkbox"]');
var indicesToDelete = [];
checkboxes.forEach(function(cb, i) { if (cb.checked) indicesToDelete.push(i); });
indicesToDelete.reverse().forEach(function(i) { currentFiles.splice(i, 1); });
renderFileList();
if (currentSubPanel === 'foldermanager') renderFolderManager();
if (currentSubPanel === 'filerename') renderRenamerList();
});

saveOrderBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!currentGalleryId) return;
var fileLists = {}; try { fileLists = GM_getValue('file_lists', {}); } catch(e) {}
var existingData = fileLists[currentGalleryId];
var folderName = (existingData && !Array.isArray(existingData) && existingData.folderName) ? existingData.folderName : null;
fileLists[currentGalleryId] = folderName ? { folderName: folderName, files: currentFiles } : currentFiles;
GM_setValue('file_lists', fileLists);
saveOrderBtn.textContent = '已保存 ✓'; setTimeout(function() { saveOrderBtn.textContent = 'Save Order'; }, 1500);
});

saveFolderBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!currentGalleryId) return;
var fileLists = {}; try { fileLists = GM_getValue('file_lists', {}); } catch(e) {}
var existingData = fileLists[currentGalleryId];
var folderName = (existingData && !Array.isArray(existingData) && existingData.folderName) ? existingData.folderName : null;
fileLists[currentGalleryId] = folderName ? { folderName: folderName, files: currentFiles } : currentFiles;
GM_setValue('file_lists', fileLists);
saveFolderBtn.textContent = '已保存 ✓'; setTimeout(function() { saveFolderBtn.textContent = 'Save'; }, 1500);
});

saveRenameBtn.addEventListener('click', function(e) {
e.preventDefault();
if (!currentGalleryId) return;
var fileLists = {}; try { fileLists = GM_getValue('file_lists', {}); } catch(e) {}
var existingData = fileLists[currentGalleryId];
var folderName = (existingData && !Array.isArray(existingData) && existingData.folderName) ? existingData.folderName : null;
fileLists[currentGalleryId] = folderName ? { folderName: folderName, files: currentFiles } : currentFiles;
GM_setValue('file_lists', fileLists);
renamerSnapshot = currentFiles.map(function(f) { return Object.assign({}, f); });
saveRenameBtn.textContent = '已保存 ✓'; setTimeout(function() { saveRenameBtn.textContent = 'Save'; }, 1500);
});

function refreshGallerySelect() {
var prevId = currentGalleryId;
while (gallerySelect.options.length > 0) gallerySelect.remove(0);
var noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '--- 選擇圖庫 ---'; gallerySelect.appendChild(noneOpt);
var saved = []; try { saved = GM_getValue('saved_galleries', []); } catch(e) {}
saved.forEach(function(g) {
var opt = document.createElement('option'); opt.value = g.id; opt.textContent = (g.title2 || g.title1 || '(無標題)'); gallerySelect.appendChild(opt);
});
if (prevId) {
gallerySelect.value = prevId;
if (gallerySelect.value === prevId) {
var fileLists = {}; try { fileLists = GM_getValue('file_lists', {}); } catch(e) {}
var fileListData = fileLists[prevId];
if (Array.isArray(fileListData)) { currentFiles = fileListData.slice(); }
else if (fileListData && fileListData.files) { currentFiles = fileListData.files.slice(); }
else { currentFiles = []; }
} else { currentGalleryId = null; currentFiles = []; }
} else { currentFiles = []; }
renderFileList();
if (currentSubPanel === 'foldermanager') renderFolderManager();
if (currentSubPanel === 'filerename') renderRenamerList();
}

container.refreshPanel = function() { refreshGallerySelect(); };

gallerySelect.addEventListener('change', function() {
currentGalleryId = this.value;
if (!currentGalleryId) { currentFiles = []; renderFileList(); renderFolderManager(); renderRenamerList(); return; }
var fileLists = {}; try { fileLists = GM_getValue('file_lists', {}); } catch(e) {}
var fileListData = fileLists[currentGalleryId];
if (Array.isArray(fileListData)) { currentFiles = fileListData.slice(); }
else if (fileListData && fileListData.files) { currentFiles = fileListData.files.slice(); }
else { currentFiles = []; }
renderFileList();
if (currentSubPanel === 'foldermanager') renderFolderManager();
if (currentSubPanel === 'filerename') renderRenamerList();
});

container.addEventListener('show', function() {
if (firstOpen) { firstOpen = false; switchTab('filelist'); }
refreshGallerySelect();
});

return container;
}

// ==================== Setting 面板 ====================

function createSettingPanel(sectionDiv) {
var container = document.createElement('div');
container.className = 'setting-container';
container.style.cssText = 'display: none; padding: 10px; background-color: #E0DED3; border: 1px solid #5C0D12; position: relative;';

var title = document.createElement('div');
title.textContent = '設置';
title.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px; user-select: text;';
container.appendChild(title);
container.style.userSelect = 'text';

var settings = loadSettings();

var row1 = document.createElement('div');
row1.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
var label1 = document.createElement('label'); label1.textContent = '自定義根文件夾:'; label1.style.cssText = 'font-size: 9pt; width: 120px; flex-shrink: 0;';
var rootFolderStatus = document.createElement('span'); rootFolderStatus.style.cssText = 'font-size: 8pt; color: #5C0D12; flex-shrink: 0; white-space: nowrap;';
var input1 = document.createElement('input'); input1.type = 'text'; input1.value = settings.customRootFolder || ''; input1.placeholder = '保存後自動要求授權';
input1.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
input1.addEventListener('blur', function() {
dbGet('handles', 'root_folder_handle').then(function(handle) {
if (!handle) { rootFolderStatus.textContent = '未授權'; return; }
return handle.queryPermission({ mode: 'read' }).then(function(perm) { rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '未授權'; });
}).catch(function() { rootFolderStatus.textContent = '未授權'; });
});
dbGet('handles', 'root_folder_handle').then(function(handle) {
if (!handle) { rootFolderStatus.textContent = '未授權'; return; }
return handle.queryPermission({ mode: 'read' }).then(function(perm) { rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '未授權'; });
}).catch(function() { rootFolderStatus.textContent = '未授權'; });
row1.appendChild(label1); row1.appendChild(input1); row1.appendChild(rootFolderStatus); container.appendChild(row1);

var row2 = document.createElement('div'); row2.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
var label2 = document.createElement('label'); label2.textContent = '創建失敗重試次數 (1-10):'; label2.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0;';
var input2 = document.createElement('input'); input2.type = 'number'; input2.min = '1'; input2.max = '10'; input2.value = settings.retryCount || 3;
input2.style.cssText = 'width: 60px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
input2.addEventListener('input', function() { var v = parseInt(this.value); if (isNaN(v) || v < 1) this.value = 1; if (v > 10) this.value = 10; });
row2.appendChild(label2); row2.appendChild(input2); container.appendChild(row2);

var row3 = document.createElement('div'); row3.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
var cb3 = document.createElement('input'); cb3.type = 'checkbox'; cb3.checked = settings.translatedDefaultMTL; cb3.style.cssText = 'margin: 0; accent-color: #5C0D12;';
var label3 = document.createElement('label'); label3.textContent = '勾選 Translated 時默認啟用 MTL'; label3.style.cssText = 'font-size: 9pt;';
row3.appendChild(cb3); row3.appendChild(label3); container.appendChild(row3);

var row4 = document.createElement('div'); row4.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
var cb4 = document.createElement('input'); cb4.type = 'checkbox'; cb4.checked = settings.nonJapaneseDefaultTranslated; cb4.style.cssText = 'margin: 0; accent-color: #5C0D12;';
var label4 = document.createElement('label'); label4.textContent = '選擇除 Japanese 的語言時默認啟用 Translated'; label4.style.cssText = 'font-size: 9pt;';
row4.appendChild(cb4); row4.appendChild(label4); container.appendChild(row4);

var rowLogConsole = document.createElement('div'); rowLogConsole.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var cbLogConsole = document.createElement('input'); cbLogConsole.type = 'checkbox'; cbLogConsole.checked = settings.logToBrowserConsole || false; cbLogConsole.style.cssText = 'margin: 0; accent-color: #5C0D12;';
var labelLogConsole = document.createElement('label'); labelLogConsole.textContent = '在瀏覽器主控台中輸出控制台訊息'; labelLogConsole.style.cssText = 'font-size: 9pt; user-select: text;';
rowLogConsole.appendChild(cbLogConsole); rowLogConsole.appendChild(labelLogConsole); container.appendChild(rowLogConsole);

var row5 = document.createElement('div'); row5.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var cb5 = document.createElement('input'); cb5.type = 'checkbox'; cb5.checked = settings.deleteDoubleConfirm; cb5.style.cssText = 'margin: 0; accent-color: #5C0D12;';
var label5 = document.createElement('label'); label5.textContent = '刪除時需要雙重確認'; label5.style.cssText = 'font-size: 9pt; user-select: text;';
row5.appendChild(cb5); row5.appendChild(label5); container.appendChild(row5);

var row6 = document.createElement('div'); row6.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var label6 = document.createElement('label'); label6.textContent = '雙重確認時間 (毫秒, 0-10000):'; label6.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0; user-select: text;';
var input6 = document.createElement('input'); input6.type = 'number'; input6.min = '0'; input6.max = '10000'; input6.value = settings.doubleConfirmMs || 1000;
input6.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
input6.addEventListener('input', function() { var v = parseInt(this.value); if (isNaN(v) || v < 0) this.value = 0; if (v > 10000) this.value = 10000; });
row6.appendChild(label6); row6.appendChild(input6); container.appendChild(row6);

var rowConfirmColor = document.createElement('div'); rowConfirmColor.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var cbConfirmColor = document.createElement('input'); cbConfirmColor.type = 'checkbox'; cbConfirmColor.checked = (settings.confirmBtnColorChange !== false); cbConfirmColor.style.cssText = 'margin: 0; accent-color: #5C0D12;';
var labelConfirmColor = document.createElement('label'); labelConfirmColor.textContent = '讀取確認按鈕是否變色'; labelConfirmColor.style.cssText = 'font-size: 9pt; user-select: text;';
rowConfirmColor.appendChild(cbConfirmColor); rowConfirmColor.appendChild(labelConfirmColor); container.appendChild(rowConfirmColor);

var rowConfirmColorMs = document.createElement('div'); rowConfirmColorMs.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var labelConfirmColorMs = document.createElement('label'); labelConfirmColorMs.textContent = '確認按鈕變色時長 (毫秒):'; labelConfirmColorMs.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0; user-select: text;';
var inputConfirmColorMs = document.createElement('input'); inputConfirmColorMs.type = 'number'; inputConfirmColorMs.min = '0'; inputConfirmColorMs.max = '10000'; inputConfirmColorMs.value = settings.confirmBtnColorMs || 1000;
inputConfirmColorMs.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
inputConfirmColorMs.addEventListener('input', function() { var v = parseInt(this.value); if (isNaN(v) || v < 0) this.value = 0; if (v > 10000) this.value = 10000; });
rowConfirmColorMs.appendChild(labelConfirmColorMs); rowConfirmColorMs.appendChild(inputConfirmColorMs); container.appendChild(rowConfirmColorMs);

var rowPreviewSize = document.createElement('div'); rowPreviewSize.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
var labelPreviewW = document.createElement('label'); labelPreviewW.textContent = '預覧圖片最大寬度 (px):'; labelPreviewW.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; user-select: text;';
var inputPreviewW = document.createElement('input'); inputPreviewW.type = 'number'; inputPreviewW.min = '1'; inputPreviewW.max = '9999'; inputPreviewW.value = settings.previewMaxWidth || 800;
inputPreviewW.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
inputPreviewW.addEventListener('input', function() { var v = parseInt(this.value); if (isNaN(v) || v < 1) this.value = 1; if (v > 9999) this.value = 9999; });
var labelPreviewH = document.createElement('label'); labelPreviewH.textContent = '最大高度 (px):'; labelPreviewH.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; user-select: text; margin-left: 16px;';
var inputPreviewH = document.createElement('input'); inputPreviewH.type = 'number'; inputPreviewH.min = '1'; inputPreviewH.max = '9999'; inputPreviewH.value = settings.previewMaxHeight || 800;
inputPreviewH.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
inputPreviewH.addEventListener('input', function() { var v = parseInt(this.value); if (isNaN(v) || v < 1) this.value = 1; if (v > 9999) this.value = 9999; });
rowPreviewSize.appendChild(labelPreviewW); rowPreviewSize.appendChild(inputPreviewW); rowPreviewSize.appendChild(labelPreviewH); rowPreviewSize.appendChild(inputPreviewH); container.appendChild(rowPreviewSize);

var priorityTitle = document.createElement('div');
priorityTitle.textContent = '特殊標記優先度（數字越小越優先，Anthology 和 Language 為固定位置）';
priorityTitle.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; margin: 10px 0 6px 0; border-top: 1px solid #5C0D12; padding-top: 6px;';
container.appendChild(priorityTitle);

var priorityKeys = [
{ key: 'mtl', label: 'MTL', tagMain: '[MTL]', tagJp: '' },
{ key: 'digital', label: 'Digital/DL版', tagMain: '[Digital]', tagJp: '[DL版]' },
{ key: 'decensored', label: 'Decensored/無修正', tagMain: '[Decensored]', tagJp: '[無修正]' },
{ key: 'colorized', label: 'Colorized/カラー化', tagMain: '[Colorized]', tagJp: '[カラー化]' },
{ key: 'textless', label: 'Textless/無字', tagMain: '[Textless]', tagJp: '[無字]' },
{ key: 'sample', label: 'Sample/見本', tagMain: '[Sample]', tagJp: '[見本]' },
{ key: 'aiGenerated', label: 'AI Generated/AI生成', tagMain: '[AI Generated]', tagJp: '[AI生成]' },
{ key: 'ongoing', label: 'Ongoing/進行中', tagMain: '[Ongoing]', tagJp: '[進行中]' },
{ key: 'incomplete', label: 'Incomplete/ページ欠落', tagMain: '[Incomplete]', tagJp: '[ページ欠落]' }
];

var currentPriorities = settings.optionPriorities || {};
var priorityList = priorityKeys.map(function(item) {
return { key: item.key, label: item.label, tagMain: item.tagMain, tagJp: item.tagJp, priority: currentPriorities[item.key] || 99 };
});
priorityList.sort(function(a, b) { return a.priority - b.priority; });

var previewDiv = document.createElement('div');
previewDiv.style.cssText = 'font-size: 9pt; color: #333; padding: 4px 0; margin-bottom: 6px; word-break: break-all; line-height: 1.8;';

function updatePreview() {
var mainLine = '[Anthology] Title [Chinese]';
var jpLine = '[アンソロジー] タイトル [中国翻訳]';
priorityList.forEach(function(item) { mainLine += ' ' + item.tagMain; if (item.tagJp) jpLine += ' ' + item.tagJp; });
previewDiv.innerHTML = '<span style="display:block;">' + mainLine + '</span><span style="display:block;">' + jpLine + '</span>';
}
updatePreview();
container.appendChild(previewDiv);

var priorityTable = document.createElement('div');
priorityTable.style.cssText = 'border: 1px solid #5C0D12; background-color: #E0DED3; max-width: 320px;';

function rebuildPriorityList() {
while (priorityTable.firstChild) priorityTable.removeChild(priorityTable.firstChild);
priorityList.forEach(function(item, index) {
var row = document.createElement('div');
row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 3px 8px; background-color: #E0DED3;' + (index < priorityList.length - 1 ? 'border-bottom: 1px solid #5C0D12;' : '');
var labelEl = document.createElement('span'); labelEl.textContent = item.label; labelEl.style.cssText = 'font-size: 9pt; flex: 1; min-width: 160px;';
var upBtn = document.createElement('button'); upBtn.textContent = '↑'; upBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; line-height: 18px; box-sizing: border-box;';
if (index === 0) { upBtn.style.opacity = '0.3'; upBtn.style.cursor = 'default'; }
upBtn.addEventListener('click', function(e) { e.preventDefault(); if (index === 0) return; var tmp = priorityList[index]; priorityList[index] = priorityList[index-1]; priorityList[index-1] = tmp; rebuildPriorityList(); updatePreview(); });
var downBtn = document.createElement('button'); downBtn.textContent = '↓'; downBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 22px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; line-height: 18px; box-sizing: border-box;';
if (index === priorityList.length - 1) { downBtn.style.opacity = '0.3'; downBtn.style.cursor = 'default'; }
downBtn.addEventListener('click', function(e) { e.preventDefault(); if (index === priorityList.length - 1) return; var tmp = priorityList[index]; priorityList[index] = priorityList[index+1]; priorityList[index+1] = tmp; rebuildPriorityList(); updatePreview(); });
row.appendChild(labelEl); row.appendChild(upBtn); row.appendChild(downBtn);
priorityTable.appendChild(row);
});
}
rebuildPriorityList();
container.appendChild(priorityTable);

var saveRow = document.createElement('div');
saveRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 10px;';
var saveSettingsBtn = document.createElement('button');
saveSettingsBtn.textContent = '保存設置';
saveSettingsBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
saveSettingsBtn.addEventListener('mouseenter', function() { this.style.backgroundColor = '#7A1E24'; });
saveSettingsBtn.addEventListener('mouseleave', function() { this.style.backgroundColor = '#5C0D12'; });
saveSettingsBtn.addEventListener('click', function(e) {
e.preventDefault();
var newRootFolder = input1.value.trim();
var newPriorities = {};
priorityList.forEach(function(item, index) { newPriorities[item.key] = index + 1; });
var newSettings = {
customRootFolder: newRootFolder, retryCount: parseInt(input2.value) || 3,
translatedDefaultMTL: cb3.checked, nonJapaneseDefaultTranslated: cb4.checked,
deleteDoubleConfirm: cb5.checked, doubleConfirmMs: parseInt(input6.value) || 1000,
logToBrowserConsole: cbLogConsole.checked,
confirmBtnColorChange: cbConfirmColor.checked,
confirmBtnColorMs: parseInt(inputConfirmColorMs.value) || 1000,
previewMaxWidth: parseInt(inputPreviewW.value) || 800,
previewMaxHeight: parseInt(inputPreviewH.value) || 800,
optionPriorities: newPriorities
};
saveSettings(newSettings); currentSettings = newSettings;
if (newRootFolder && window.showDirectoryPicker) {
rootFolderStatus.textContent = '等待授權...';
window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' })
.then(function(handle) {
return dbSet('handles', 'root_folder_handle', handle).then(function() {
return handle.queryPermission({ mode: 'read' });
}).then(function(perm) { rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '授權失敗'; });
})
.catch(function(err) { rootFolderStatus.textContent = err.name !== 'AbortError' ? '授權失敗' : '已取消'; });
}
saveSettingsBtn.textContent = '已保存 ✓';
setTimeout(function() { saveSettingsBtn.textContent = '保存設置'; }, 1500);
});
var clearCacheBtn = document.createElement('button');
clearCacheBtn.textContent = '清理緩存';
clearCacheBtn.style.cssText = 'background-color: #8B0000; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; margin-right: 8px;';
clearCacheBtn.addEventListener('mouseenter', function() { this.style.backgroundColor = '#A00000'; });
clearCacheBtn.addEventListener('mouseleave', function() { this.style.backgroundColor = '#8B0000'; });
clearCacheBtn.addEventListener('click', function(e) {
e.preventDefault();
var msg1 = '確認要清理緩存嗎？\n\n將刪除以下內容：\n• 已保存的圖庫資料\n• 文件列表\n• 評論模板\n• 掃描的文件夾\n• 本地文件夾授權\n• 所有待處理任務\n• 外部字典緩存\n\n將保留：\n• 腳本設置\n• 本地自定義字典';
if (!confirm(msg1)) return;
if (!confirm('二次確認：所有資料將永久刪除，無法復原。確定繼續？')) return;
var gmKeys = [
'saved_galleries', 'file_lists', 'comment_templates',
'scanned_folders', 'local_folders',
'scanned_folders', 'local_folders',
'pending_create', 'pending_create_queue', 'pending_upload',
'create_success'
];
gmKeys.forEach(function(key) {
  GM_deleteValue(key);
  });
  _log('[ClearCache] GM 數據已清除');
var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
dbReq.onsuccess = function() {
_log('[ClearCache] IndexedDB 已刪除');
var unpublishedSection = document.querySelector('.s[data-custom="true"]');
if (unpublishedSection) unpublishedSection.remove();
clearCacheBtn.textContent = '已清空 ✓';
clearCacheBtn.style.backgroundColor = '#007700';
setTimeout(function() {
clearCacheBtn.textContent = '清空緩存';
clearCacheBtn.style.backgroundColor = '#8B0000';
}, 2000);
};
dbReq.onerror = function(ev) {
_error('[ClearCache] IndexedDB 刪除失敗:', ev.target.error);
clearCacheBtn.textContent = '清空失敗';
clearCacheBtn.style.backgroundColor = '#CC0000';
setTimeout(function() {
clearCacheBtn.textContent = '清空緩存';
clearCacheBtn.style.backgroundColor = '#8B0000';
}, 2000);
};
dbReq.onblocked = function() {
_warn('[ClearCache] IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
clearCacheBtn.textContent = '請關閉其他分頁';
clearCacheBtn.style.backgroundColor = '#CC6600';
setTimeout(function() {
clearCacheBtn.textContent = '清空緩存';
clearCacheBtn.style.backgroundColor = '#8B0000';
}, 3000);
};
});

var resetDictBtn = document.createElement('button');
resetDictBtn.textContent = '重置字典';
resetDictBtn.style.cssText = 'background-color: #8B4500; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; margin-right: 8px;';
resetDictBtn.addEventListener('mouseenter', function() { this.style.backgroundColor = '#A05000'; });
resetDictBtn.addEventListener('mouseleave', function() { this.style.backgroundColor = '#8B4500'; });
resetDictBtn.addEventListener('click', function(e) {
e.preventDefault();
var msg1 = '確認要重置字典嗎？\n\n將刪除以下內容：\n• 外部字典緩存\n\n下次使用羅馬字轉換時將自動重新下載。\n\n將保留：\n• 所有用戶數據\n• 腳本設置\n• 本地自定義字典';
if (!confirm(msg1)) return;
if (!confirm('二次確認：此操作無法復原。確定繼續？')) return;
var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
dbReq.onsuccess = function() {
_log('[ResetDict] IndexedDB 已刪除');
resetDictBtn.textContent = '已重置 ✓';
resetDictBtn.style.backgroundColor = '#007700';
setTimeout(function() {
resetDictBtn.textContent = '重置字典';
resetDictBtn.style.backgroundColor = '#8B4500';
}, 2000);
};
dbReq.onerror = function(ev) {
_error('[ResetDict] IndexedDB 刪除失敗:', ev.target.error);
resetDictBtn.textContent = '重置失敗';
resetDictBtn.style.backgroundColor = '#CC0000';
setTimeout(function() {
resetDictBtn.textContent = '重置字典';
resetDictBtn.style.backgroundColor = '#8B4500';
}, 2000);
};
dbReq.onblocked = function() {
_warn('[ResetDict] IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
resetDictBtn.textContent = '請關閉其他分頁';
resetDictBtn.style.backgroundColor = '#CC6600';
setTimeout(function() {
resetDictBtn.textContent = '重置字典';
resetDictBtn.style.backgroundColor = '#8B4500';
}, 3000);
};
});

saveRow.appendChild(clearCacheBtn);
saveRow.appendChild(resetDictBtn);

var resetSettingsBtn = document.createElement('button');
resetSettingsBtn.textContent = '重置設置';
resetSettingsBtn.style.cssText = 'background-color: #5C6B00; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; margin-left: 8px; margin-right: auto;';
resetSettingsBtn.addEventListener('mouseenter', function() { this.style.backgroundColor = '#6E7F00'; });
resetSettingsBtn.addEventListener('mouseleave', function() { this.style.backgroundColor = '#5C6B00'; });
resetSettingsBtn.addEventListener('click', function(e) {
e.preventDefault();
var msg1 = '確認要重置設置嗎？\n\n將刪除本地設置並還原至默認值。\n\n將保留：\n• 已保存的圖庫資料\n• 本地自定義字典\n• 外部字典緩存';
if (!confirm(msg1)) return;
if (!confirm('二次確認：此操作無法復原。確定繼續？')) return;
try {
GM_deleteValue('fifybuj_settings');
var defaultSettings = getDefaultSettings();
GM_setValue('fifybuj_settings', defaultSettings);
_log('[ResetSettings] 設置已重置為默認值');
resetSettingsBtn.textContent = '已重置 ✓';
resetSettingsBtn.style.backgroundColor = '#007700';
setTimeout(function() {
resetSettingsBtn.textContent = '重置設置';
resetSettingsBtn.style.backgroundColor = '#5C6B00';
window.location.reload();
}, 2000);
} catch(err) {
_error('[ResetSettings] 重置失敗:', err);
resetSettingsBtn.textContent = '重置失敗';
resetSettingsBtn.style.backgroundColor = '#CC0000';
setTimeout(function() {
resetSettingsBtn.textContent = '重置設置';
resetSettingsBtn.style.backgroundColor = '#5C6B00';
}, 2000);
}
});

saveRow.appendChild(resetSettingsBtn);
saveRow.appendChild(saveSettingsBtn);
container.appendChild(saveRow);
return container;
}

// ==================== createUnpublishedSection ====================

function createUnpublishedSection(btnRef) {
if (document.querySelector('.s[data-custom="true"]')) return;

var originalSection = Array.from(document.querySelectorAll('.s')).find(function(section) {
var leftDiv = section.querySelector('.h .l');
return leftDiv && leftDiv.textContent.includes('Unpublished Galleries');
});
if (!originalSection) return;

var waitingCreateCountRef = { value: 0 };

var sectionDiv = document.createElement('div');
sectionDiv.className = 's';
sectionDiv.setAttribute('data-custom', 'true');
sectionDiv.style.marginBottom = '20px';

var headerDiv = document.createElement('div'); headerDiv.className = 'h';
var leftDiv = document.createElement('div'); leftDiv.className = 'l'; leftDiv.textContent = 'Auto Create & Upload'; leftDiv.style.fontWeight = 'bold';
var rightDiv = document.createElement('div'); rightDiv.className = 'r'; rightDiv.innerHTML = '[<a href="#" class="close-custom-section">Close</a>]';
var clearDiv = document.createElement('div'); clearDiv.className = 'c';
headerDiv.appendChild(leftDiv); headerDiv.appendChild(rightDiv); headerDiv.appendChild(clearDiv);
sectionDiv.appendChild(headerDiv);

var toolRowDiv = document.createElement('div');
toolRowDiv.style.cssText = 'padding: 3px 4px; background-color: #E0DED3; border-top: 1px solid #5C0D12; display: flex; align-items: center; justify-content: flex-end; white-space: nowrap; gap: 4px;';

var allCatLabel = document.createElement('span'); allCatLabel.textContent = 'All Category:'; allCatLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
toolRowDiv.appendChild(allCatLabel);
var toolCatSelect = createCategorySelect('Doujinshi'); toolCatSelect.style.verticalAlign = 'middle'; toolRowDiv.appendChild(toolCatSelect);
var catGoBtn = createGoBtn(); catGoBtn.style.marginRight = '8px';
catGoBtn.addEventListener('click', function(e) { e.preventDefault(); applyToChecked(tbody, function(tr1) { var catSel = tr1.querySelector('td.gtc4 select'); if (catSel) catSel.value = toolCatSelect.value; }); });
toolRowDiv.appendChild(catGoBtn);

var allLangLabel = document.createElement('span'); allLangLabel.textContent = 'All Language:'; allLangLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
toolRowDiv.appendChild(allLangLabel);
var toolLangSelect = createLangSelect(); toolLangSelect.style.verticalAlign = 'middle'; toolRowDiv.appendChild(toolLangSelect);
var langGoBtn = createGoBtn(); langGoBtn.style.marginRight = '8px';
langGoBtn.addEventListener('click', function(e) { e.preventDefault(); applyToChecked(tbody, function(tr1) { var selects = tr1.querySelectorAll('td.gtc4 select'); if (selects[1]) selects[1].value = toolLangSelect.value; }); });
toolRowDiv.appendChild(langGoBtn);

var allFolderLabel = document.createElement('span'); allFolderLabel.textContent = 'All Folder:'; allFolderLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
toolRowDiv.appendChild(allFolderLabel);
var toolFolderSelect = createFolderSelect(); toolFolderSelect.style.verticalAlign = 'middle'; toolRowDiv.appendChild(toolFolderSelect);
var folderGoBtn = createGoBtn(); folderGoBtn.style.marginRight = '8px';
folderGoBtn.addEventListener('click', function(e) { e.preventDefault(); applyToChecked(tbody, function(tr1) { var selects = tr1.querySelectorAll('td.gtc4 select'); if (selects[2]) selects[2].value = toolFolderSelect.value; }); });
toolRowDiv.appendChild(folderGoBtn);

var allLabel = document.createElement('span'); allLabel.textContent = 'All:'; allLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
toolRowDiv.appendChild(allLabel);
var actionSelect = document.createElement('select');
applySelectStyle(actionSelect, '80px'); actionSelect.style.verticalAlign = 'middle';
['Save', 'Create', 'Delete'].forEach(function(val) { var option = document.createElement('option'); option.value = val; option.textContent = val; actionSelect.appendChild(option); });
toolRowDiv.appendChild(actionSelect);
var actionGoBtn = createGoBtn();
actionGoBtn.addEventListener('click', function(e) {
e.preventDefault();
var action = actionSelect.value;
if (action === 'Save') {
allSaveChecked(tbody, folderRow1);
actionGoBtn.style.backgroundColor = '#999999'; actionGoBtn.style.color = '#CCCCCC'; actionGoBtn.style.borderColor = '#999999';
setTimeout(function() { actionGoBtn.style.backgroundColor = '#E0DED3'; actionGoBtn.style.color = '#5C0D12'; actionGoBtn.style.borderColor = '#5C0D12'; }, 500);
} else if (action === 'Create') { allCreateChecked(tbody); }
else if (action === 'Delete') { allDeleteChecked(tbody, folderRow1, waitingCreateCountRef); }
});
toolRowDiv.appendChild(actionGoBtn);
sectionDiv.appendChild(toolRowDiv);

var optionsRowDiv = document.createElement('div');
optionsRowDiv.style.cssText = 'padding: 3px 4px; background-color: #E0DED3; border-top: 1px solid #5C0D12; display: flex; align-items: center; white-space: nowrap; gap: 4px;';

var optionsLeft = document.createElement('div');
optionsLeft.style.cssText = 'display: grid !important; grid-template-areas: "cg cl sp off tra rew dig dec ai" "cg cl sp col tex inc sam ong ant" !important; grid-template-columns: max-content max-content 1fr max-content max-content max-content max-content max-content max-content !important; grid-template-rows: auto auto !important; column-gap: 8px !important; row-gap: 2px !important; align-items: center !important; width: 100% !important;';
optionsLeft.style.cssText = 'display: grid !important; grid-template-areas: "cg as cl sp off tra rew dig dec ai" "cg as cl sp col tex inc sam ong ant" !important; grid-template-columns: max-content max-content max-content 1fr max-content max-content max-content max-content max-content max-content !important; grid-template-rows: auto auto !important; column-gap: 8px !important; row-gap: 2px !important; align-items: center !important; width: 100% !important;';

  var createGalleryBtn2 = document.createElement('button');
createGalleryBtn2.innerHTML = 'Create<br>Gallery';
createGalleryBtn2.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; padding: 0 4px; cursor: pointer; border-radius: 3px; white-space: normal; box-sizing: border-box; text-align: center; grid-area: cg; align-self: stretch; word-break: keep-all; line-height: 1.4; width: 100%;';
createGalleryBtn2.addEventListener('click', function(e) {
e.preventDefault();
var folderToggle1 = folderRow1.querySelector('.folder-toggle');
if (folderToggle1 && folderToggle1.textContent === '[+]') {
var nextRow = folderRow1.nextElementSibling;
while (nextRow) { if (!nextRow.classList.contains('gtr')) nextRow.style.display = 'table-row'; nextRow = nextRow.nextElementSibling; }
folderToggle1.textContent = '[-]';
var spans = folderRight1.querySelectorAll('span'); spans.forEach(function(span) { span.style.display = ''; });
}
var newGroup = createGalleryGroup(waitingCreateCountRef.value, null, tbody, folderRow1, sectionDiv, waitingCreateCountRef);
tbody.appendChild(newGroup);
waitingCreateCountRef.value++;
var folderStrong1 = folderRow1.querySelector('strong');
if (folderStrong1) folderStrong1.textContent = waitingCreateCountRef.value;
requestAnimationFrame(function() { fixAllGroups(sectionDiv, folderRow1); });
});

var cleanBtn = document.createElement('button');
cleanBtn.textContent = 'Clean';
cleanBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 4px; cursor: pointer; border-radius: 3px; white-space: nowrap; box-sizing: border-box; text-align: center; grid-area: cl; align-self: stretch; width: 100%;';

var spacer = document.createElement('div'); spacer.style.cssText = 'grid-area: sp;';

var cbOpt_official = document.createElement('span'); cbOpt_official.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: off;';
var cbOpt_officialCb = document.createElement('input'); cbOpt_officialCb.type = 'checkbox'; cbOpt_officialCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_official.appendChild(cbOpt_officialCb); cbOpt_official.appendChild(document.createTextNode('Official / Textless'));

var cbOpt_translatedWrap = document.createElement('span'); cbOpt_translatedWrap.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; min-width: max-content; grid-area: tra;';
var cbOpt_translatedCb = document.createElement('input'); cbOpt_translatedCb.type = 'checkbox'; cbOpt_translatedCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_translatedWrap.appendChild(cbOpt_translatedCb); cbOpt_translatedWrap.appendChild(document.createTextNode('Translated'));
var cbOpt_mtlInner = document.createElement('span'); cbOpt_mtlInner.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; visibility: hidden; margin-left: 6px;';
var cbOpt_mtlCb = document.createElement('input'); cbOpt_mtlCb.type = 'checkbox'; cbOpt_mtlCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_mtlInner.appendChild(cbOpt_mtlCb); cbOpt_mtlInner.appendChild(document.createTextNode('MTL'));
cbOpt_translatedWrap.appendChild(cbOpt_mtlInner);

var cbOpt_rewrite = document.createElement('span'); cbOpt_rewrite.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: rew;';
var cbOpt_rewriteCb = document.createElement('input'); cbOpt_rewriteCb.type = 'checkbox'; cbOpt_rewriteCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_rewrite.appendChild(cbOpt_rewriteCb); cbOpt_rewrite.appendChild(document.createTextNode('Rewrite'));

var cbOpt_digital = document.createElement('span'); cbOpt_digital.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: dig;';
var cbOpt_digitalCb = document.createElement('input'); cbOpt_digitalCb.type = 'checkbox'; cbOpt_digitalCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_digital.appendChild(cbOpt_digitalCb); cbOpt_digital.appendChild(document.createTextNode('Digital/DL版'));

var cbOpt_decensored = document.createElement('span'); cbOpt_decensored.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: dec;';
var cbOpt_decensoredCb = document.createElement('input'); cbOpt_decensoredCb.type = 'checkbox'; cbOpt_decensoredCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_decensored.appendChild(cbOpt_decensoredCb); cbOpt_decensored.appendChild(document.createTextNode('Decensored/無修正'));

var cbOpt_aiGenerated = document.createElement('span'); cbOpt_aiGenerated.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: ai;';
var cbOpt_aiGeneratedCb = document.createElement('input'); cbOpt_aiGeneratedCb.type = 'checkbox'; cbOpt_aiGeneratedCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_aiGenerated.appendChild(cbOpt_aiGeneratedCb); cbOpt_aiGenerated.appendChild(document.createTextNode('AI Generated/AI生成'));

var cbOpt_colorized = document.createElement('span'); cbOpt_colorized.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: col;';
var cbOpt_colorizedCb = document.createElement('input'); cbOpt_colorizedCb.type = 'checkbox'; cbOpt_colorizedCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_colorized.appendChild(cbOpt_colorizedCb); cbOpt_colorized.appendChild(document.createTextNode('Colorized/カラー化'));

var cbOpt_textless = document.createElement('span'); cbOpt_textless.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: tex;';
var cbOpt_textlessCb = document.createElement('input'); cbOpt_textlessCb.type = 'checkbox'; cbOpt_textlessCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_textless.appendChild(cbOpt_textlessCb); cbOpt_textless.appendChild(document.createTextNode('Textless/無字'));

var cbOpt_incomplete = document.createElement('span'); cbOpt_incomplete.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: inc;';
var cbOpt_incompleteCb = document.createElement('input'); cbOpt_incompleteCb.type = 'checkbox'; cbOpt_incompleteCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_incomplete.appendChild(cbOpt_incompleteCb); cbOpt_incomplete.appendChild(document.createTextNode('Incomplete/ページ欠落'));

var cbOpt_sample = document.createElement('span'); cbOpt_sample.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: sam;';
var cbOpt_sampleCb = document.createElement('input'); cbOpt_sampleCb.type = 'checkbox'; cbOpt_sampleCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_sample.appendChild(cbOpt_sampleCb); cbOpt_sample.appendChild(document.createTextNode('Sample/見本'));

var cbOpt_ongoing = document.createElement('span'); cbOpt_ongoing.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: ong;';
var cbOpt_ongoingCb = document.createElement('input'); cbOpt_ongoingCb.type = 'checkbox'; cbOpt_ongoingCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_ongoing.appendChild(cbOpt_ongoingCb); cbOpt_ongoing.appendChild(document.createTextNode('Ongoing/進行中'));

var cbOpt_anthology = document.createElement('span'); cbOpt_anthology.style.cssText = 'display: inline-flex; align-items: center; white-space: nowrap; grid-area: ant;';
var cbOpt_anthologyCb = document.createElement('input'); cbOpt_anthologyCb.type = 'checkbox'; cbOpt_anthologyCb.style.cssText = 'margin: 0 2px 0 0; accent-color: #5C0D12;';
cbOpt_anthology.appendChild(cbOpt_anthologyCb); cbOpt_anthology.appendChild(document.createTextNode('Anthology/アンソロジー'));

cbOpt_officialCb.checked = true;

cbOpt_officialCb.addEventListener('click', function() { if (!cbOpt_translatedCb.checked && !cbOpt_rewriteCb.checked) { this.checked = true; return; } cbOpt_translatedCb.checked = false; cbOpt_rewriteCb.checked = false; cbOpt_mtlInner.style.visibility = 'hidden'; cbOpt_mtlCb.checked = false; });
cbOpt_translatedCb.addEventListener('click', function() { if (!cbOpt_officialCb.checked && !cbOpt_rewriteCb.checked) { this.checked = true; return; } cbOpt_officialCb.checked = false; cbOpt_rewriteCb.checked = false; cbOpt_mtlInner.style.visibility = 'visible'; cbOpt_mtlCb.checked = true; });
cbOpt_rewriteCb.addEventListener('click', function() { if (!cbOpt_officialCb.checked && !cbOpt_translatedCb.checked) { this.checked = true; return; } cbOpt_officialCb.checked = false; cbOpt_translatedCb.checked = false; cbOpt_mtlInner.style.visibility = 'hidden'; cbOpt_mtlCb.checked = false; });

  var allSaveBtn = document.createElement('button');
  allSaveBtn.innerHTML = 'All<br>Save';
  allSaveBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; padding: 0 4px; cursor: pointer; border-radius: 3px; white-space: normal; box-sizing: border-box; text-align: center; grid-area: as; align-self: stretch; word-break: keep-all; line-height: 1.4;';
  allSaveBtn.addEventListener('click', function(e) {
    e.preventDefault();
    document.querySelectorAll('button').forEach(function(btn) {
      if (btn.textContent === 'save' && btn.closest('tr')) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
      }
    });
  });
  optionsLeft.appendChild(createGalleryBtn2); optionsLeft.appendChild(allSaveBtn); optionsLeft.appendChild(cleanBtn); optionsLeft.appendChild(spacer);
  optionsLeft.appendChild(cbOpt_official); optionsLeft.appendChild(cbOpt_translatedWrap); optionsLeft.appendChild(cbOpt_rewrite);
optionsLeft.appendChild(cbOpt_digital); optionsLeft.appendChild(cbOpt_decensored); optionsLeft.appendChild(cbOpt_aiGenerated);
optionsLeft.appendChild(cbOpt_colorized); optionsLeft.appendChild(cbOpt_textless); optionsLeft.appendChild(cbOpt_incomplete);
optionsLeft.appendChild(cbOpt_sample); optionsLeft.appendChild(cbOpt_ongoing); optionsLeft.appendChild(cbOpt_anthology);

var optionsGoBtn = createGoBtn();
optionsGoBtn.style.marginLeft = '8px'; optionsGoBtn.style.flexShrink = '0'; optionsGoBtn.style.alignSelf = 'center';
optionsGoBtn.addEventListener('click', function(e) {
e.preventDefault();
applyToChecked(tbody, function(tr1, group) {
var tr2 = group[1];
var checkboxes = tr2.querySelectorAll('td.gtc-options input[type="checkbox"]');
if (checkboxes.length >= 12) {
checkboxes[1].checked = cbOpt_officialCb.checked; checkboxes[4].checked = cbOpt_translatedCb.checked;
checkboxes[0].checked = cbOpt_mtlCb.checked; checkboxes[7].checked = cbOpt_rewriteCb.checked;
checkboxes[10].checked = cbOpt_digitalCb.checked; checkboxes[11].checked = cbOpt_sampleCb.checked;
checkboxes[5].checked = cbOpt_decensoredCb.checked; checkboxes[2].checked = cbOpt_aiGeneratedCb.checked;
checkboxes[8].checked = cbOpt_colorizedCb.checked; checkboxes[6].checked = cbOpt_incompleteCb.checked;
checkboxes[9].checked = cbOpt_ongoingCb.checked; checkboxes[3].checked = cbOpt_anthologyCb.checked;
var mtlSpanEl = tr2.querySelector('td.gtc-options > span:first-child');
if (mtlSpanEl) { mtlSpanEl.style.display = cbOpt_translatedCb.checked ? 'inline-flex' : 'none'; }
}
});
});

cleanBtn.addEventListener('click', function(e) {
e.preventDefault();
cbOpt_officialCb.checked = true; cbOpt_translatedCb.checked = false; cbOpt_rewriteCb.checked = false;
cbOpt_mtlInner.style.visibility = 'hidden'; cbOpt_mtlCb.checked = false;
cbOpt_digitalCb.checked = false; cbOpt_decensoredCb.checked = false; cbOpt_aiGeneratedCb.checked = false;
cbOpt_colorizedCb.checked = false; cbOpt_textlessCb.checked = false; cbOpt_incompleteCb.checked = false;
cbOpt_sampleCb.checked = false; cbOpt_ongoingCb.checked = false; cbOpt_anthologyCb.checked = false;
});

optionsRowDiv.appendChild(optionsLeft); optionsRowDiv.appendChild(optionsGoBtn);
sectionDiv.appendChild(optionsRowDiv);

var buttonRow = document.createElement('div');
buttonRow.style.cssText = 'padding: 5px 2px; background-color: #E0DED3; border-bottom: 1px solid #5C0D12; border-top: 1px solid #5C0D12; display: flex; align-items: center;';

var analyzeBtn = document.createElement('a'); analyzeBtn.href = '#'; analyzeBtn.innerHTML = '[Analyze Mode]'; analyzeBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 5px; cursor: pointer; background-color: #E0DED3;';
var settingBtn = document.createElement('a'); settingBtn.href = '#'; settingBtn.innerHTML = '[Setting]'; settingBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
var commentTemplateBtn = document.createElement('a'); commentTemplateBtn.href = '#'; commentTemplateBtn.innerHTML = '[Comment Template]'; commentTemplateBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
var dictManagerBtn = document.createElement('a'); dictManagerBtn.href = '#'; dictManagerBtn.innerHTML = '[Dict Manager]'; dictManagerBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
var showFileListBtn = document.createElement('a'); showFileListBtn.href = '#'; showFileListBtn.innerHTML = '[Gallery Folder Manager]'; showFileListBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
var consoleBtn = document.createElement('a'); consoleBtn.href = '#'; consoleBtn.innerHTML = '[Console]'; consoleBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';

buttonRow.appendChild(analyzeBtn); buttonRow.appendChild(showFileListBtn); buttonRow.appendChild(settingBtn); buttonRow.appendChild(commentTemplateBtn); buttonRow.appendChild(dictManagerBtn); buttonRow.appendChild(consoleBtn);
sectionDiv.appendChild(buttonRow);

var inputContainer = document.createElement('div');
inputContainer.className = 'analyze-input-container';
inputContainer.style.cssText = 'display: none; padding: 10px; background-color: #E0DED3; border: 1px solid #5C0D12; position: relative;';

var analyzeTitle = document.createElement('div');
analyzeTitle.textContent = 'Analyze Mode';
analyzeTitle.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
inputContainer.appendChild(analyzeTitle);

var analyzeDropZone = document.createElement('div');
analyzeDropZone.style.cssText = 'border: 2px dashed #5C0D12; border-radius: 6px; padding: 30px 20px; text-align: center; cursor: pointer; background-color: #EDE9DF; margin-bottom: 10px; transition: background-color 0.2s;';
analyzeDropZone.style.cssText = 'display: flex; gap: 8px; margin-bottom: 10px;';
var archiveZone = document.createElement('div');
archiveZone.style.cssText = 'flex: 1; border: 2px dashed #5C0D12; border-radius: 6px; padding: 30px 20px; text-align: center; cursor: pointer; background-color: #EDE9DF; transition: background-color 0.2s;';
archiveZone.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">📦</div><div style="font-size: 9pt; color: #5C0D12;">拖入壓縮檔<br>ZIP<br>或點擊選擇</div>';
var folderZone = document.createElement('div');
folderZone.style.cssText = 'flex: 1; border: 2px dashed #5C0D12; border-radius: 6px; padding: 30px 20px; text-align: center; cursor: pointer; background-color: #EDE9DF; transition: background-color 0.2s;';
folderZone.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">📁</div><div style="font-size: 9pt; color: #5C0D12;">拖入/選擇<br>文件夾<br>或點擊選擇</div>';
analyzeDropZone.appendChild(archiveZone);
analyzeDropZone.appendChild(folderZone);

var analyzeFileInput = document.createElement('input');
analyzeFileInput.type = 'file';
analyzeFileInput.accept = '.zip,.z01,.z02,.z03,.z04,.z05,.z06,.z07,.z08,.z09';
analyzeFileInput.multiple = true;
analyzeFileInput.style.display = 'none';

var analyzeStatusBtn = document.createElement('div');
analyzeStatusBtn.style.cssText = 'text-align: center; font-size: 9pt; color: #5C0D12; min-height: 20px; margin-bottom: 8px;';

var analyzeResultsDiv = document.createElement('div');
analyzeResultsDiv.style.cssText = 'border: 1px solid #5C0D12; background-color: #EDE9DF; min-height: 40px; max-height: 500px; overflow-y: auto; display: none; margin-bottom: 10px;';

var analyzeBottomRow = document.createElement('div');
analyzeBottomRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;';
var analyzeCreateAllBtn = document.createElement('button');
analyzeCreateAllBtn.textContent = '全部建立圖庫';
analyzeCreateAllBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold; display: none;';
analyzeBottomRow.appendChild(analyzeCreateAllBtn);

var analyzeEntries = [];

function buildFileTree(files) {
var tree = {};
files.forEach(function(f) {
var parts = (f.path || f.name || '').split('/');
var node = tree;
parts.forEach(function(part, idx) {
if (idx === parts.length - 1) {
if (!node.__files__) node.__files__ = [];
node.__files__.push(part);
} else {
if (!node[part]) node[part] = {};
node = node[part];
}
});
});
return tree;
}

function renderTree(tree, depth) {
var html = '';
var keys = Object.keys(tree).filter(function(k) { return k !== '__files__'; }).sort(function(a, b) { return naturalCompare(a, b); });
keys.forEach(function(key) {
var indent = depth * 16;
html += '<div style="padding: 1px 4px 1px ' + (indent + 4) + 'px; font-size: 9pt; color: #333;">📁 ' + key + '/</div>';
html += renderTree(tree[key], depth + 1);
});
var files = tree.__files__ || [];
files.sort(function(a, b) { return naturalCompare(a, b); });
files.forEach(function(f) {
var indent = depth * 16;
html += '<div style="padding: 1px 4px 1px ' + (indent + 4) + 'px; font-size: 8pt; color: #666;">📄 ' + f + '</div>';
});
return html;
}

function renderAnalyzeResults() {
if (analyzeEntries.length === 0) {
analyzeResultsDiv.style.display = 'none';
analyzeCreateAllBtn.style.display = 'none';
return;
}
analyzeResultsDiv.style.display = 'block';
analyzeCreateAllBtn.style.display = 'inline-block';
while (analyzeResultsDiv.firstChild) analyzeResultsDiv.removeChild(analyzeResultsDiv.firstChild);
analyzeEntries.forEach(function(entry, idx) {
var tree = buildFileTree(entry.files);
var imageCount = entry.files.length;
var entryDiv = document.createElement('div');
entryDiv.style.cssText = 'padding: 8px; border-bottom: 1px solid #5C0D12;';
var headerRow = document.createElement('div');
headerRow.style.cssText = 'display: flex; align-items: center; margin-bottom: 4px;';
var titleSpan = document.createElement('span');
titleSpan.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; flex: 1;';
titleSpan.textContent = '📦 ' + entry.title;
var delBtn = document.createElement('button');
delBtn.textContent = '✕';
delBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; width: 20px; height: 20px; cursor: pointer; border-radius: 3px; padding: 0; flex-shrink: 0;';
(function(i) {
delBtn.addEventListener('click', function(e) {
e.preventDefault();
analyzeEntries.splice(i, 1);
renderAnalyzeResults();
});
})(idx);
headerRow.appendChild(titleSpan);
headerRow.appendChild(delBtn);
entryDiv.appendChild(headerRow);
var countDiv = document.createElement('div');
countDiv.style.cssText = 'font-size: 9pt; color: #333; margin-bottom: 4px;';
countDiv.textContent = '文件數：' + imageCount + ' 個圖片' + (entry.skipped > 0 ? '（跳過 ' + entry.skipped + ' 個）' : '');
entryDiv.appendChild(countDiv);
var treeLabel = document.createElement('div');
treeLabel.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold; margin-bottom: 2px;';
treeLabel.textContent = '資料夾結構：';
entryDiv.appendChild(treeLabel);
var treeDiv = document.createElement('div');
treeDiv.style.cssText = 'max-height: 200px; overflow-y: auto; border: 1px solid rgba(92,13,18,0.2); background: #E0DED3; margin-bottom: 4px;';
treeDiv.innerHTML = renderTree(tree, 0);
entryDiv.appendChild(treeDiv);
analyzeResultsDiv.appendChild(entryDiv);
});
}

function handleAnalyzeFiles(files) {
analyzeStatusBtn.textContent = '讀取中...';
analyzeStatusBtn.style.color = '#5C0D12';
handleArchiveFiles(files, null, function(results) {
if (results.length === 0) {
analyzeStatusBtn.textContent = '無法讀取檔案';
analyzeStatusBtn.style.color = '#CC0000';
setTimeout(function() { analyzeStatusBtn.textContent = ''; }, 2000);
return;
}
results.forEach(function(r) { analyzeEntries.push(r); });
analyzeStatusBtn.textContent = '讀取完成，共 ' + analyzeEntries.length + ' 個項目';
setTimeout(function() { analyzeStatusBtn.textContent = ''; }, 2000);
renderAnalyzeResults();
});
}

function handleAnalyzeFolder() {
if (!window.showDirectoryPicker) { _log('showDirectoryPicker not supported'); return; }
analyzeStatusBtn.textContent = '讀取文件夾中...';
window.showDirectoryPicker({ mode: 'read' }).then(function(dirHandle) {
var imageFiles = [];
var skipped = 0;
function scanDir(handle, prefix) {
_log('[Progress] 文件夾:', prefix || '/');
var entries = handle.values();
function processEntries() {
return entries.next().then(function(result) {
if (result.done) return;
var entry = result.value;
var fullPath = prefix ? prefix + '/' + entry.name : entry.name;
if (entry.kind === 'file') {
_log('[Progress] 文件:', fullPath);
var ext = entry.name.split('.').pop().toLowerCase();
if (ACCEPTED_FORMATS.indexOf(ext) === -1) { skipped++; return processEntries(); }
imageFiles.push({ name: entry.name, path: fullPath });
return processEntries();
} else if (entry.kind === 'directory') {
return handle.getDirectoryHandle(entry.name).then(function(subHandle) {
return scanDir(subHandle, fullPath).then(processEntries);
});
}
return processEntries();
});
}
return processEntries();
}
scanDir(dirHandle, '').then(function() {
imageFiles.sort(function(a, b) { return naturalCompare(a.path, b.path); });
if (imageFiles.length > MAX_FILES) { imageFiles = imageFiles.slice(0, MAX_FILES); }
var entry = { title: dirHandle.name, folderName: dirHandle.name, files: imageFiles, skipped: skipped };
analyzeEntries.push(entry);
analyzeStatusBtn.textContent = '讀取完成';
setTimeout(function() { analyzeStatusBtn.textContent = ''; }, 2000);
renderAnalyzeResults();
});
}).catch(function(err) {
if (err.name !== 'AbortError') {
_error('[AnalyzeFolder] 錯誤:', err);
analyzeStatusBtn.textContent = '讀取失敗';
analyzeStatusBtn.style.color = '#CC0000';
setTimeout(function() { analyzeStatusBtn.textContent = ''; analyzeStatusBtn.style.color = '#5C0D12'; }, 2000);
} else {
analyzeStatusBtn.textContent = '';
}
});
}

archiveZone.addEventListener('click', function(e) {
e.preventDefault();
analyzeFileInput.click();
});
archiveZone.addEventListener('dragover', function(e) {
e.preventDefault();
e.stopPropagation();
archiveZone.style.backgroundColor = '#D0CEC3';
});
archiveZone.addEventListener('dragleave', function(e) {
e.preventDefault();
archiveZone.style.backgroundColor = '#EDE9DF';
});
archiveZone.addEventListener('drop', function(e) {
e.preventDefault();
e.stopPropagation();
archiveZone.style.backgroundColor = '#EDE9DF';
var files = Array.from(e.dataTransfer.files);
if (files.length > 0) { handleAnalyzeFiles(files); }
});

folderZone.addEventListener('click', function(e) {
e.preventDefault();
handleAnalyzeFolder();
});
folderZone.addEventListener('dragover', function(e) {
e.preventDefault();
e.stopPropagation();
folderZone.style.backgroundColor = '#D0CEC3';
});
folderZone.addEventListener('dragleave', function(e) {
e.preventDefault();
folderZone.style.backgroundColor = '#EDE9DF';
});
folderZone.addEventListener('drop', function(e) {
e.preventDefault();
e.stopPropagation();
folderZone.style.backgroundColor = '#EDE9DF';
if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
var item = e.dataTransfer.items[0];
if (item.kind === 'file') {
var entry = item.webkitGetAsEntry();
if (entry && entry.isDirectory) {
_log('[Analyze] 拖入文件夾:', entry.name);
handleAnalyzeFolder();
return;
}
}
}
var files = Array.from(e.dataTransfer.files);
if (files.length > 0) { handleAnalyzeFiles(files); }
});

analyzeFileInput.addEventListener('change', function() {
var files = Array.from(analyzeFileInput.files);
if (files.length > 0) { handleAnalyzeFiles(files); }
analyzeFileInput.value = '';
});

analyzeCreateAllBtn.addEventListener('click', function(e) {
e.preventDefault();
if (analyzeEntries.length === 0) return;
var existingGalleries = GM_getValue('saved_galleries', []);
analyzeEntries.forEach(function(entry, idx) {
var galleryData = {
id: Date.now() + '_' + idx + '_' + entry.title,
title1: entry.title,
title2: entry.title,
files: String(entry.files.length),
category: 'Doujinshi',
language: '0',
folder: 'Unsorted',
options: {
official: true, translated: false, rewrite: false,
digital: false, decensored: false, aiGenerated: false,
colorized: false, textless: false, incomplete: false,
sample: false, anthology: false, ongoing: false
},
mtl: false,
comment: '',
timestamp: Date.now()
};
existingGalleries.push(galleryData);
if (entry.files && entry.files.length > 0) {
var fileList = GM_getValue('file_lists', {});
fileList[galleryData.id] = { folderName: entry.folderName || null, files: entry.files };
GM_setValue('file_lists', fileList);
}
});
GM_setValue('saved_galleries', existingGalleries);
_log('[Analyze] 已建立 ' + analyzeEntries.length + ' 個圖庫到 Waiting Create');
analyzeCreateAllBtn.textContent = '已建立 ✓';
setTimeout(function() { analyzeCreateAllBtn.textContent = '全部建立圖庫'; }, 1500);
var panel = document.querySelector('.show-file-list-container');
if (panel && panel.refreshPanel) panel.refreshPanel();
var customSection = document.querySelector('.s[data-custom="true"]');
if (customSection) {
var tbody = customSection.querySelector('tbody');
var folderRow1 = customSection.querySelector('tr.gtr');
var folderRight1 = folderRow1 ? folderRow1.querySelector('td.r') : null;
if (tbody && folderRow1 && folderRight1) {
var waitingRef = { value: parseInt((folderRow1.querySelector('strong') || {}).textContent || '0') };
analyzeEntries.forEach(function(entry, idx) {
var savedId = Date.now() + '_' + idx + '_' + entry.title;
var savedData = existingGalleries[existingGalleries.length - analyzeEntries.length + idx];
var newGroup = createGalleryGroup(waitingRef.value, savedData, tbody, folderRow1, customSection, waitingRef);
tbody.appendChild(newGroup);
waitingRef.value++;
});
var folderStrong = folderRow1.querySelector('strong');
if (folderStrong) folderStrong.textContent = waitingRef.value;
requestAnimationFrame(function() { fixAllGroups(customSection, folderRow1); });
}
}
analyzeEntries = [];
renderAnalyzeResults();
});

inputContainer.appendChild(analyzeDropZone);
inputContainer.appendChild(analyzeFileInput);
inputContainer.appendChild(analyzeStatusBtn);
inputContainer.appendChild(analyzeResultsDiv);
inputContainer.appendChild(analyzeBottomRow);
sectionDiv.appendChild(inputContainer);

var settingPanel = createSettingPanel(sectionDiv);
sectionDiv.appendChild(settingPanel);

var commentTemplatePanel = createCommentTemplatePanel();
sectionDiv.appendChild(commentTemplatePanel);
var dictManagerPanel = createDictManagerPanel();
sectionDiv.appendChild(dictManagerPanel);

var showFileListPanel = createShowFileListPanel();
sectionDiv.appendChild(showFileListPanel);

var consolePanelEl = createConsolePanel();
sectionDiv.appendChild(consolePanelEl);

var allPanels = [
{ btn: analyzeBtn, panel: inputContainer },
{ btn: settingBtn, panel: settingPanel },
{ btn: commentTemplateBtn, panel: commentTemplatePanel },
{ btn: dictManagerBtn, panel: dictManagerPanel },
{ btn: showFileListBtn, panel: showFileListPanel },
{ btn: consoleBtn, panel: consolePanelEl }
];

function togglePanel(targetPanel) {
var isVisible = targetPanel.style.display !== 'none';
allPanels.forEach(function(p) { p.panel.style.display = 'none'; });
if (!isVisible) { targetPanel.style.display = 'block'; targetPanel.dispatchEvent(new Event('show')); }
}

analyzeBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(inputContainer); });
settingBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(settingPanel); });
commentTemplateBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(commentTemplatePanel); });
dictManagerBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(dictManagerPanel); });
showFileListBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(showFileListPanel); });
consoleBtn.addEventListener('click', function(e) { e.preventDefault(); togglePanel(consolePanelEl); });

var contentTable = document.createElement('table');
contentTable.className = 'mt';
contentTable.style.cssText = 'width: 100% !important; table-layout: fixed !important; background-color: #E0DED3 !important; border-collapse: collapse !important;';

var thead = document.createElement('thead');
var headerRow = document.createElement('tr');
var th1 = document.createElement('th'); th1.className = 'h1'; th1.style.cssText = 'text-align: left !important; padding-left: 4px !important;'; th1.textContent = 'Gallery Name';
var th2 = document.createElement('th'); th2.className = 'h3'; th2.style.cssText = 'text-align: right !important; width: 50px !important; padding-right: 10px !important;'; th2.textContent = 'Files';
var th3 = document.createElement('th'); th3.className = 'h4'; th3.style.cssText = 'text-align: left !important; width: 100px !important;'; th3.textContent = 'Public Category';
var th4 = document.createElement('th'); th4.className = 'h4'; th4.style.cssText = 'text-align: left !important; width: 140px !important; white-space: nowrap !important;'; th4.textContent = 'Gallery Language';
var th5 = document.createElement('th'); th5.className = 'h4'; th5.style.cssText = 'text-align: left !important; width: auto !important; min-width: 155px !important; white-space: nowrap !important;'; th5.textContent = 'Gallery Folder';
var th6 = document.createElement('th'); th6.className = 'h6'; th6.style.cssText = 'text-align: right !important; width: 40px !important; padding-right: 1px !important;'; th6.innerHTML = '&nbsp;';
headerRow.appendChild(th1); headerRow.appendChild(th2); headerRow.appendChild(th3); headerRow.appendChild(th4); headerRow.appendChild(th5); headerRow.appendChild(th6);
thead.appendChild(headerRow); contentTable.appendChild(thead);

var tbody = document.createElement('tbody');

var folderRow1 = document.createElement('tr'); folderRow1.className = 'gtr'; folderRow1.id = 'frow_custom_1';
var folderLeft1 = document.createElement('td'); folderLeft1.colSpan = 4; folderLeft1.className = 'l';
folderLeft1.innerHTML = '<a id="ft_custom_1" class="folder-toggle" href="#" data-folder="1">[-]</a>&nbsp; <strong>0</strong>&nbsp; <span>Waiting Create</span>';
folderRow1.appendChild(folderLeft1);
var folderRight1 = document.createElement('td'); folderRight1.colSpan = 2; folderRight1.className = 'r';
folderRight1.style.cssText = 'text-align: right !important; padding-right: 1px !important;';
folderRight1.innerHTML = '<span class="select-all" data-folder="1">+ All</span> <span class="deselect-all" data-folder="1">- All</span>';
folderRow1.appendChild(folderRight1);
tbody.appendChild(folderRow1);

var toggle1 = folderRow1.querySelector('.folder-toggle');
toggle1.addEventListener('click', function(e) {
e.preventDefault();
var isExpanded = this.textContent === '[-]';
var nextRow = folderRow1.nextElementSibling;
while (nextRow) { if (!nextRow.classList.contains('gtr')) { nextRow.style.display = isExpanded ? 'none' : 'table-row'; } nextRow = nextRow.nextElementSibling; }
this.textContent = isExpanded ? '[+]' : '[-]';
var spans = folderRight1.querySelectorAll('span');
spans.forEach(function(span) { span.style.display = isExpanded ? 'none' : ''; });
});

sectionDiv.addEventListener('click', function(e) {
var target = e.target;
if (target.classList.contains('select-all')) {
e.preventDefault();
var folderRow = target.closest('tr.gtr'); var nextRow = folderRow.nextElementSibling;
while (nextRow && !nextRow.classList.contains('gtr')) { var firstRowCheckbox = nextRow.querySelector('td.gtc6 input[type="checkbox"]'); if (firstRowCheckbox) firstRowCheckbox.checked = true; nextRow = nextRow.nextElementSibling; }
} else if (target.classList.contains('deselect-all')) {
e.preventDefault();
var folderRow = target.closest('tr.gtr'); var nextRow = folderRow.nextElementSibling;
while (nextRow && !nextRow.classList.contains('gtr')) { var firstRowCheckbox = nextRow.querySelector('td.gtc6 input[type="checkbox"]'); if (firstRowCheckbox) firstRowCheckbox.checked = false; nextRow = nextRow.nextElementSibling; }
}
});

contentTable.appendChild(tbody);
sectionDiv.appendChild(contentTable);
originalSection.parentNode.insertBefore(sectionDiv, originalSection);

var styleId = 'final-alignment';
if (!document.getElementById(styleId)) {
var style = document.createElement('style');
style.id = styleId;
style.textContent =
'.s[data-custom="true"] td.gtc4 { text-align: left !important; padding-left: 2px !important; }' +
'.s[data-custom="true"] td.gtc4 select { margin-left: 0 !important; display: block !important; }' +
'.s[data-custom="true"] td.gtc-options > span:first-child { position: absolute !important; }' +
'tr.gtr td.r { padding-right: 1px !important; text-align: right !important; }' +
'.s[data-custom="true"] tbody tr:not(.gtr) { background-color: #EDE9DF !important; }' +
'.s[data-custom="true"] input[type="text"], .s[data-custom="true"] input[type="number"], .s[data-custom="true"] textarea, .s[data-custom="true"] select { background-color: #E0DED3 !important; }' +
'.s[data-custom="true"] input[type="checkbox"] { accent-color: #5C0D12 !important; }';
document.head.appendChild(style);
}

sectionDiv.querySelector('.close-custom-section').addEventListener('click', function(e) {
e.preventDefault(); sectionDiv.remove();
if (!document.querySelector('.s[data-custom="true"]')) { var btn = document.getElementById('auto-create-upload-btn'); if (btn) btn.style.fontWeight = 'normal'; }
});

loadSavedGalleries(tbody, folderRow1, folderRight1, sectionDiv, waitingCreateCountRef);
}

// ==================== 頁面路由 ====================

function addButtonToPage() {
var path = window.location.pathname;
if (path.includes('/managefolders')) { addScanFolderButton(); }
else if (path.includes('/manage') && !path.includes('/managegallery') && !path.includes('/managefolders')) { addAutoCreateButton(); }
}

function addScanFolderButton() {
if (document.getElementById('scan-folder-btn')) return;
var lbContainer = document.getElementById('lb');
if (!lbContainer) return;
var createNewDiv = Array.from(lbContainer.querySelectorAll('div')).find(function(div) { var link = div.querySelector('a'); return link && link.textContent.includes('Create New Gallery'); });
if (!createNewDiv) return;
var newDiv = document.createElement('div');
var newLink = document.createElement('a'); newLink.id = 'scan-folder-btn'; newLink.href = '#'; newLink.innerHTML = '[Scan Folder List]'; newLink.style.fontWeight = 'normal';
newDiv.appendChild(newLink);
var localLink = document.createElement('a'); localLink.id = 'local-folder-btn'; localLink.href = '#'; localLink.innerHTML = ' [Local Folder]'; localLink.style.fontWeight = 'normal';
newDiv.appendChild(localLink);
createNewDiv.insertAdjacentElement('afterend', newDiv);
newLink.addEventListener('click', function(e) { e.preventDefault(); scanFolders(); });
localLink.addEventListener('click', function(e) { e.preventDefault(); showLocalFolderUI(); });
}

function showLocalFolderUI() {
if (document.getElementById('local-folder-panel')) { document.getElementById('local-folder-panel').remove(); return; }
var localFolders = getLocalFolders();
var panel = document.createElement('div');
panel.id = 'local-folder-panel';
panel.style.cssText = 'margin: 10px 0; padding: 10px; border: 1px solid #5C0D12; background-color: #E0DED3;';
var titleDiv = document.createElement('div');
titleDiv.textContent = 'Local Folder Manager';
titleDiv.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
panel.appendChild(titleDiv);
var table = document.createElement('table');
table.style.cssText = 'width: 100%; border-collapse: collapse;';
var thead = document.createElement('thead');
var headRow = document.createElement('tr');
var th1 = document.createElement('th'); th1.textContent = 'Folder Name'; th1.style.cssText = 'text-align: left; padding: 4px; font-size: 9pt; color: #5C0D12;';
var th2 = document.createElement('th'); th2.textContent = 'Display Order'; th2.style.cssText = 'width: 80px; text-align: center; padding: 4px; font-size: 9pt; color: #5C0D12;';
var th3 = document.createElement('th'); th3.style.cssText = 'width: 60px;';
headRow.appendChild(th1); headRow.appendChild(th2); headRow.appendChild(th3);
thead.appendChild(headRow);
table.appendChild(thead);
var tbody = document.createElement('tbody');
function renderRows() {
while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
localFolders.forEach(function(folder, idx) {
var tr = document.createElement('tr');
var td1 = document.createElement('td'); td1.style.cssText = 'text-align: right; padding: 4px 15px 4px 4px;';
var nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.value = folder; nameInput.size = 50;
nameInput.style.cssText = 'border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px;';
if (folder === 'Waiting Create') nameInput.readOnly = true;
nameInput.addEventListener('change', function() { localFolders[idx] = nameInput.value; });
td1.appendChild(nameInput);
var td2 = document.createElement('td'); td2.style.cssText = 'text-align: center; padding: 4px;';
var orderSelect = document.createElement('select');
orderSelect.style.cssText = 'width: 80px; font-size: 8pt; border: 1px solid #5C0D12; background: #E0DED3;';
for (var i = 1; i <= localFolders.length; i++) {
var opt = document.createElement('option'); opt.value = String(i); opt.textContent = String(i);
if (i === idx + 1) opt.selected = true;
orderSelect.appendChild(opt);
}
orderSelect.addEventListener('change', function() {
var newIdx = parseInt(orderSelect.value) - 1;
var moved = localFolders.splice(idx, 1)[0];
localFolders.splice(newIdx, 0, moved);
renderRows();
});
td2.appendChild(orderSelect);
var td3 = document.createElement('td'); td3.style.cssText = 'padding: 4px; text-align: center;';
if (folder !== 'Waiting Create') {
var delLink = document.createElement('a'); delLink.href = '#'; delLink.textContent = '[Delete]';
delLink.style.cssText = 'font-size: 9pt; color: #5C0D12;';
delLink.addEventListener('click', function(e) {
e.preventDefault();
if (confirm('Are you sure you wish to delete the folder ' + folder + '?')) {
localFolders.splice(idx, 1);
renderRows();
}
});
td3.appendChild(delLink);
}
tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
tbody.appendChild(tr);
});
}
renderRows();
table.appendChild(tbody);
panel.appendChild(table);
var bottomRow = document.createElement('div');
bottomRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px; align-items: center;';
var newFolderInput = document.createElement('input'); newFolderInput.type = 'text'; newFolderInput.placeholder = 'New folder name'; newFolderInput.size = 50;
newFolderInput.style.cssText = 'border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px;';
var createBtn = document.createElement('button'); createBtn.textContent = 'Create Folder';
createBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 12px; cursor: pointer; border-radius: 3px; height: 24px;';
createBtn.addEventListener('click', function(e) {
e.preventDefault();
var name = newFolderInput.value.trim();
if (!name) return;
if (localFolders.indexOf(name) !== -1) { alert('Folder already exists'); return; }
localFolders.push(name);
newFolderInput.value = '';
renderRows();
});
var spacer = document.createElement('div'); spacer.style.cssText = 'flex: 1;';
var saveBtn = document.createElement('button'); saveBtn.textContent = 'Save Changes';
saveBtn.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: none; border-radius: 3px; padding: 4px 16px; cursor: pointer; font-size: 9pt; font-weight: bold;';
saveBtn.addEventListener('click', function(e) {
e.preventDefault();
saveLocalFolders(localFolders);
saveBtn.textContent = '已保存 ✓';
setTimeout(function() { saveBtn.textContent = 'Save Changes'; }, 1500);
});
bottomRow.appendChild(newFolderInput); bottomRow.appendChild(createBtn); bottomRow.appendChild(spacer); bottomRow.appendChild(saveBtn);
panel.appendChild(bottomRow);
var scanBtn = document.getElementById('scan-folder-btn');
if (scanBtn && scanBtn.closest('div')) {
scanBtn.closest('div').insertAdjacentElement('afterend', panel);
}
}

function scanFolders() {
var folderInputs = document.querySelectorAll('input[name^="fn"]');
var folders = [];
folderInputs.forEach(function(input) { var folderName = input.value.trim(); if (folderName) folders.push(folderName); });
var uniqueFolders = Array.from(new Set(folders));
uniqueFolders.sort(function(a, b) { return a.localeCompare(b); });
GM_setValue('scanned_folders', uniqueFolders);
alert('已掃描 ' + uniqueFolders.length + ' 個文件夾：\n' + uniqueFolders.join('\n'));
}

function addAutoCreateButton() {
if (document.getElementById('auto-create-upload-btn')) return;
var lbContainer = document.getElementById('lb');
if (!lbContainer) return;
var allDivs = Array.from(lbContainer.querySelectorAll('div'));
var lastDiv = allDivs[allDivs.length - 1];
if (!lastDiv) return;
var createNewLink = lastDiv.querySelector('a');
if (!createNewLink || (!createNewLink.textContent.includes('Create New Gallery') && !createNewLink.href.includes('act=new'))) return;
var newDiv = document.createElement('div');
var newLink = document.createElement('a'); newLink.id = 'auto-create-upload-btn'; newLink.href = '#'; newLink.innerHTML = '[Auto Create & Upload]'; newLink.style.fontWeight = 'normal';
newDiv.appendChild(newLink);
lastDiv.insertAdjacentElement('afterend', newDiv);
newLink.addEventListener('click', function(e) { e.preventDefault(); this.style.fontWeight = 'bold'; createUnpublishedSection(this); });
}

// ==================== 監聽 ====================

function setupCreateSuccessListener() {
if (!window.location.pathname.includes('/manage') || window.location.pathname.includes('/managegallery') || window.location.pathname.includes('/managefolders')) return;
try {
GM_addValueChangeListener('create_success', function(name, oldVal, newVal) {
if (!newVal) return;
var customSection = document.querySelector('.s[data-custom="true"]');
if (!customSection) return;
var allTrs = customSection.querySelectorAll('tbody tr:not(.gtr)');
var groups = []; var currentGroup = [];
allTrs.forEach(function(tr) { currentGroup.push(tr); if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; } });
groups.forEach(function(group) {
var tr2 = group[1]; var sid = tr2.dataset.savedDataId;
if (sid && sid === newVal) {
group.forEach(function(tr) { tr.remove(); });
var saved = GM_getValue('saved_galleries', []);
GM_setValue('saved_galleries', saved.filter(function(r) { return r.id !== newVal; }));
var fl = GM_getValue('file_lists', {}); delete fl[newVal]; GM_setValue('file_lists', fl);
var folderStrong = customSection.querySelector('tr.gtr strong');
if (folderStrong) { var count = parseInt(folderStrong.textContent) || 0; folderStrong.textContent = Math.max(0, count - 1); }
}
});
GM_setValue('create_success', null);
});
} catch(e) { _log('GM_addValueChangeListener 不可用:', e.message); }
}

// ==================== 入口 ====================

function init() {
try {
    var _ud = GM_getValue('user_dicts', {});
} catch(e) {}
_log('=== 庫載入檢查 ===');
_log('JSZip:', typeof JSZip);
_log('Kuroshiro:', typeof Kuroshiro);
_log('KuromojiAnalyzer:', typeof KuromojiAnalyzer);

initKuroshiro();

setTimeout(function() {
dbGet('dicts', 'jmdict_data').then(function(data) {
if (!data || !Array.isArray(data) || data.length === 0) {
_log('[Init] 檢測到外部字典缺失，開始自動下載...');
var silentBtn = { disabled: false, textContent: '' };
updateAllDicts(silentBtn);
}
}).catch(function() { _log('[Init] 外部字典檢查失敗'); });
}, 2000);

addButtonToPage();
handleManageGalleryPage();
setupCreateSuccessListener();
window.addEventListener('resize', function() {
document.querySelectorAll('.s[data-custom="true"] td.gtc3').forEach(function(td) {
var btns = Array.from(td.querySelectorAll('button'));
if (btns.length > 0) alignSwapBtn(btns, td);
});
document.querySelectorAll('.s[data-custom="true"] td.gtc3 span.files-text').forEach(function(span) { var td = span.closest('td'); if (td) alignFilesText(span, td); });
});
}

init();

var observer = new MutationObserver(addButtonToPage);
observer.observe(document.body, { childList: true, subtree: true });
})();
