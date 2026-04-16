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

// ==================== Console 面板日誌 / 全域日誌控制 ====================
var _consoleLog = [];
var _consolePanel = null;

function _safeStringifyLogValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
        return JSON.stringify(value);
    } catch (e) {
        try {
            return String(value);
        } catch (e2) {
            return '[Unserializable]';
        }
    }
}

function _normalizeLogArgs(argsLike) {
    return Array.prototype.slice.call(argsLike || []).map(_safeStringifyLogValue).join(' ');
}

function _logToPanel(level, args) {
    var time = new Date().toLocaleTimeString();
    var msg = _normalizeLogArgs(args);
    _consoleLog.push({ time: time, level: level, msg: msg });
    if (_consolePanel && _consolePanel.addEntry) _consolePanel.addEntry(time, level, msg);
}

// ==================== 默認設置 ====================

function getDefaultSettings() {
    return {
        customRootFolder: '',
        customAuthorizedFolders: [],
        retryCount: 3,
        translatedDefaultMTL: true,
        nonJapaneseDefaultTranslated: false,
        japaneseDefaultOfficialTextless: false,
        japaneseDefaultAIGenerated: true,
        autoSwitchDictDropdown: true,
        logToBrowserConsole: false,
        showDebugLogsInBrowserConsole: false,
        deleteDoubleConfirm: true,
        doubleConfirmMs: 1000,
        confirmBtnColorChange: true,
        confirmBtnColorMs: 1000,
        confirmBtnSuccessColorChange: true,
        confirmBtnErrorColorChange: true,
        confirmBtnSuccessColor: '0,255,0',
        confirmBtnErrorColor: '255,0,0',
        doubleConfirmColor: '255,0,0',
        previewMaxWidth: 800,
        previewMaxHeight: 800,
        galleryFolderManagerCopyWithExtension: true,
        dictPriorityPadLength: 5,
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

function _generateAuthorizedFolderId() {
    return 'authorized_root_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

function normalizeAuthorizedFolderSettingsList(list) {
    var source = Array.isArray(list) ? list : [];
    var out = [];
    var seen = {};

    source.forEach(function(item) {
        if (!item) return;

        var id = String(item.id || '').trim() || _generateAuthorizedFolderId();
        while (seen[id]) id = _generateAuthorizedFolderId();
        seen[id] = true;

        var label = String(item.label || item.name || item.path || item.displayName || '').trim();
        if (!label) label = '授權文件夾 ' + (out.length + 1);

        out.push({
            id: id,
            label: label
        });
    });

    return out;
}

function migrateAuthorizedFolderSettings(settings) {
    var defaults = getDefaultSettings();
    var merged = Object.assign({}, defaults, settings || {});
    var folders = normalizeAuthorizedFolderSettingsList(merged.customAuthorizedFolders);
    var legacyRootLabel = String(merged.customRootFolder || '').trim();

    if (!folders.length && legacyRootLabel) {
        folders.push({
            id: _generateAuthorizedFolderId(),
            label: legacyRootLabel
        });
    }

    if (!folders.length) {
        merged.customRootFolder = '';
    } else if (folders.length === 1) {
        merged.customRootFolder = folders[0].label;
    } else if (!folders.some(function(item) { return item.label === legacyRootLabel; })) {
        merged.customRootFolder = '';
    }

    merged.customAuthorizedFolders = folders;
    delete merged.defaultAuthorizedFolderId;
    return merged;
}

function loadSettings() {
    try {
        var saved = GM_getValue('fifybuj_settings', null);
        if (saved) {
            var defaults = getDefaultSettings();
            return migrateAuthorizedFolderSettings(Object.assign({}, defaults, saved));
        }
    } catch (e) {}
    return migrateAuthorizedFolderSettings(getDefaultSettings());
}

var currentSettings = loadSettings();

function getCurrentSettingsSafe() {
    try {
        return currentSettings || loadSettings() || getDefaultSettings();
    } catch (e) {
        return getDefaultSettings();
    }
}

function shouldConsoleLog() {
    var settings = getCurrentSettingsSafe();
    return !!(settings && settings.logToBrowserConsole);
}

function _getDebugLogFilterSettingsSafe() {
    try {
        return getCurrentSettingsSafe() || {};
    } catch (e) {
        return {};
    }
}
function _normalizeDebugLogLevel(level) {
    return String(level == null ? '' : level).trim().toUpperCase();
}
function _flattenDebugLogArgs(args) {
    var list = Array.isArray(args) ? args : [args];
    return list.map(function(item) {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        if (item instanceof Error) return item.stack || item.message || String(item);
        try {
            if (item && typeof item.message === 'string') {
                return item.message + ' ' + JSON.stringify(item);
            }
        } catch (e) {}
        try {
            return JSON.stringify(item);
        } catch (e2) {}
        try {
            return String(item);
        } catch (e3) {}
        return '';
    }).join(' ');
}
function _isBrowserConsoleOutputEnabledBySettings() {
    return !!_getDebugLogFilterSettingsSafe().logToBrowserConsole;
}
function _isDebugLogOutputEnabledBySettings() {
    return !!_getDebugLogFilterSettingsSafe().showDebugLogsInBrowserConsole;
}
function _isDebugTaggedLogMessage(level, args) {
    if (_normalizeDebugLogLevel(level) === 'DEBUG') return true;
    return /\[\s*debug\s*\]/i.test(_flattenDebugLogArgs(args));
}
function _shouldAllowDebugTaggedMessage(level, args) {
    if (!_isDebugTaggedLogMessage(level, args)) return true;
    return _isDebugLogOutputEnabledBySettings();
}
function _shouldEmitBrowserConsoleMessage(level, args) {
    if (!_isBrowserConsoleOutputEnabledBySettings()) return false;
    if (!_shouldAllowDebugTaggedMessage(level, args)) return false;
    return true;
}
function _emitBrowserConsole(level, args) {
    var settings = getCurrentSettingsSafe();
    var upperLevel = String(level || '').toUpperCase();
    if (upperLevel === 'DEBUG') {
        if (!settings.showDebugLogsInBrowserConsole) return;
    } else {
        if (!settings.logToBrowserConsole) return;
    }
    var oldGetCurrentSettingsSafe = getCurrentSettingsSafe;
    try {
        getCurrentSettingsSafe = function() {
            var current = oldGetCurrentSettingsSafe();
            if (upperLevel === 'DEBUG') {
                return Object.assign({}, current, { logToBrowserConsole: true });
            }
            return current;
        };
        return _emitBrowserConsole__legacy(level, args);
    } finally {
        getCurrentSettingsSafe = oldGetCurrentSettingsSafe;
    }
}
function _emitBrowserConsole__legacy(level, args) {
    if (!shouldConsoleLog()) return;
    var method = console.log;
    if (level === 'ERROR' && console.error) method = console.error;
    else if (level === 'WARN' && console.warn) method = console.warn;
    else if (level === 'INFO' && console.info) method = console.info;
    else if (level === 'DEBUG' && console.debug) method = console.debug;
    method.apply(console, Array.prototype.slice.call(args || []));
}

function _shouldOutputToLogPanel(level, args) {
    return _shouldAllowDebugTaggedMessage(level, args);
}

function _emitControlledLog(level, args) {
    _emitBrowserConsole(level, args);
    if (!_shouldOutputToLogPanel(level, args)) return;
    if (!_shouldOutputToLogPanel(level, args)) return;
    _logToPanel(level, args);
}

function _log() { _emitControlledLog('INFO', arguments); }
function _info() { _emitControlledLog('INFO', arguments); }
function _warn() { _emitControlledLog('WARN', arguments); }
function _error() { _emitControlledLog('ERROR', arguments); }
function _debug() { _emitControlledLog('DEBUG', arguments); }

function opLog(action, payload) {
    _log('[Operation]', action, payload || '');
}

function flowLog(scope, message, payload) {
    if (payload === undefined) _log('[' + scope + ']', message);
    else _log('[' + scope + ']', message, payload);
}

function warnLog(scope, message, payload) {
    if (payload === undefined) _warn('[' + scope + ']', message);
    else _warn('[' + scope + ']', message, payload);
}

function errorLog(scope, message, payload) {
    if (payload === undefined) _error('[' + scope + ']', message);
    else _error('[' + scope + ']', message, payload);
}

function saveSettings(settings) {
    try {
        GM_setValue('fifybuj_settings', settings);
        currentSettings = Object.assign({}, getDefaultSettings(), settings || {});
        opLog('保存設置', currentSettings);
    } catch (e) {
        errorLog('Settings', '保存失敗', e.message || e);
    }
}

var _dictManagerUpdateFn = null;
var _dictManagerRefreshFns = { kuromoji: null, jmdict: null };
var _autoDictUpdateStarted = false;

// ==================== 共用 Helper：樣式 / 資料 / 靜默刷新 ====================

function applyPageToneBtnStyle(btn, extraCss) {
    if (!btn) return btn;
    btn.style.cssText =
        'background-color: #E0DED3;' +
        'border: 1px solid #5C0D12;' +
        'color: #5C0D12;' +
        'font-weight: bold;' +
        'font-size: 9pt;' +
        'cursor: pointer;' +
        'border-radius: 3px;' +
        'box-sizing: border-box;' +
        'display: inline-flex;' +
        'align-items: center;' +
        'justify-content: center;' +
        'line-height: 1;' +
        'margin: 0;' +
        (extraCss || '');
    return btn;
}

function applyPrimaryDarkBtnStyle(btn, extraCss) {
    if (!btn) return btn;
    btn.style.cssText =
        'background-color: #5C0D12;' +
        'border: 1px solid #5C0D12;' +
        'color: #FFFFFF;' +
        'font-weight: bold;' +
        'font-size: 9pt;' +
        'cursor: pointer;' +
        'border-radius: 3px;' +
        'box-sizing: border-box;' +
        'display: inline-flex;' +
        'align-items: center;' +
        'justify-content: center;' +
        'line-height: 1;' +
        'margin: 0;' +
        (extraCss || '');
    return btn;
}

function applyTopBarControlStyle(el, width, extraCss) {
    if (!el) return el;
    var isSelect = el.tagName === 'SELECT';
    var baseCss =
        'height: 26px;' +
        'min-height: 26px;' +
        'max-height: 26px;' +
        'box-sizing: border-box;' +
        'border: 1px solid #5C0D12;' +
        'border-radius: 3px;' +
        'background: #FAFAFA;' +
        'font-size: 9pt;' +
        'margin: 0;' +
        'vertical-align: middle;' +
        'outline: none;' +
        'line-height: 24px;';
    var widthCss = width ? ('width: ' + width + ';') : '';
    var paddingCss = isSelect ? 'padding: 0 4px;' : 'padding: 0 6px;';
    el.style.cssText = baseCss + widthCss + paddingCss + (extraCss || '');
    return el;
}

function _normalizeConfirmFeedbackColorCode(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    var m = text.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
    if (!m) return fallback;

    var r = parseInt(m[1], 10);
    var g = parseInt(m[2], 10);
    var b = parseInt(m[3], 10);

    if (isNaN(r) || isNaN(g) || isNaN(b)) return fallback;
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return fallback;

    return r + ',' + g + ',' + b;
}

function _getConfirmFeedbackSettingsSafe() {
    var settings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe() || {});
    var delayMs = parseInt(settings.confirmBtnColorMs, 10);
    if (!isFinite(delayMs) || delayMs < 0) delayMs = 1000;

    var globalEnabled = settings.confirmBtnColorChange !== false;
    var successEnabled = globalEnabled && settings.confirmBtnSuccessColorChange !== false;
    var errorEnabled = globalEnabled && settings.confirmBtnErrorColorChange !== false;

    var successRgb = _normalizeConfirmFeedbackColorCode(settings.confirmBtnSuccessColor, '0,255,0');
    var errorRgb = _normalizeConfirmFeedbackColorCode(settings.confirmBtnErrorColor, '255,0,0');

    function toCss(rgbText) {
        var parts = String(rgbText || '').split(',');
        var r = parseInt(parts[0], 10) || 0;
        var g = parseInt(parts[1], 10) || 0;
        var b = parseInt(parts[2], 10) || 0;
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    return {
        enabled: globalEnabled,
        successEnabled: successEnabled,
        errorEnabled: errorEnabled,
        delayMs: delayMs,
        successColor: toCss(successRgb),
        errorColor: toCss(errorRgb)
    };
}

function _getFeedbackElementText(el) {
    if (!el) return '';
    if (String(el.tagName || '').toUpperCase() === 'INPUT') return el.value;
    return el.textContent;
}

function _setFeedbackElementText(el, text) {
    if (!el || text === undefined) return;
    if (String(el.tagName || '').toUpperCase() === 'INPUT') el.value = text;
    else el.textContent = text;
}

function _captureFeedbackElementState(el) {
    var computed = null;
    try { computed = getComputedStyle(el); } catch (e) {}

    return {
        text: _getFeedbackElementText(el),
        background: el.style.background,
        backgroundColor: el.style.backgroundColor,
        color: el.style.color,
        border: el.style.border,
        borderColor: el.style.borderColor,
        borderStyle: el.style.borderStyle,
        borderWidth: el.style.borderWidth,
        outline: el.style.outline,
        outlineColor: el.style.outlineColor,
        outlineStyle: el.style.outlineStyle,
        outlineWidth: el.style.outlineWidth,
        computedBackgroundColor: computed ? computed.backgroundColor : '',
        computedColor: computed ? computed.color : '',
        computedBorderColor: computed ? computed.borderColor : '',
        computedBorderStyle: computed ? computed.borderStyle : '',
        computedBorderWidth: computed ? computed.borderWidth : '',
        computedOutlineColor: computed ? computed.outlineColor : '',
        computedOutlineStyle: computed ? computed.outlineStyle : '',
        computedOutlineWidth: computed ? computed.outlineWidth : ''
    };
}

function _restoreFeedbackElementState(el, state) {
    if (!el || !state) return;
    _setFeedbackElementText(el, state.text);

    var fallbackBg = '';
    try {
        fallbackBg = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor || '';
    } catch (e) {}
    if (!fallbackBg || fallbackBg === 'rgba(0, 0, 0, 0)' || fallbackBg === 'transparent') fallbackBg = '#E0DED3';

    var fallbackFg = '';
    try {
        fallbackFg = getComputedStyle(document.querySelector('.s .h .l') || document.body).color || '';
    } catch (e2) {}
    if (!fallbackFg || fallbackFg === 'rgba(0, 0, 0, 0)' || fallbackFg === 'transparent') fallbackFg = '#5C0D12';

    el.style.removeProperty('background');
    el.style.removeProperty('background-color');
    el.style.removeProperty('color');
    el.style.removeProperty('border');
    el.style.removeProperty('border-color');
    el.style.removeProperty('border-style');
    el.style.removeProperty('border-width');
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-color');
    el.style.removeProperty('outline-style');
    el.style.removeProperty('outline-width');

    el.style.background = state.background || '';
    el.style.backgroundColor = state.backgroundColor || '';
    if (!state.background && !state.backgroundColor) {
        var computedBg = state.computedBackgroundColor || '';
        var computedBgUsable = !!(computedBg && computedBg !== 'rgba(0, 0, 0, 0)' && computedBg !== 'transparent');
        el.style.backgroundColor = computedBgUsable ? computedBg : fallbackBg;
    }

    el.style.color = state.color || '';
    if (!state.color) {
        el.style.color = state.computedColor || fallbackFg;
    }

    el.style.border = state.border || '';
    el.style.borderColor = state.borderColor || '';
    el.style.borderStyle = state.borderStyle || '';
    el.style.borderWidth = state.borderWidth || '';

    if (!state.border && !state.borderColor) {
        el.style.borderColor = state.computedBorderColor || fallbackFg;
    }
    if (!state.border && !state.borderStyle) {
        el.style.borderStyle = (state.computedBorderStyle && state.computedBorderStyle !== 'none') ? state.computedBorderStyle : 'solid';
    }
    if (!state.border && !state.borderWidth) {
        el.style.borderWidth = (state.computedBorderWidth && state.computedBorderWidth !== '0px') ? state.computedBorderWidth : '1px';
    }

    el.style.outline = state.outline || '';
    el.style.outlineColor = state.outlineColor || '';
    el.style.outlineStyle = state.outlineStyle || '';
    el.style.outlineWidth = state.outlineWidth || '';
}

function _applyFeedbackElementState(el, state, options) {
    if (!el) return;
    options = options || {};
    if (options.text !== undefined) _setFeedbackElementText(el, options.text);

    var feedbackSettings = _getConfirmFeedbackSettingsSafe();
    if (options.useColor === false || !feedbackSettings.enabled) return;

    if (options.colorType === 'success' && !feedbackSettings.successEnabled) return;
    if (options.colorType === 'error' && !feedbackSettings.errorEnabled) return;

    var backgroundColor = options.backgroundColor || '';
    if (!backgroundColor) {
        if (options.colorType === 'success') backgroundColor = feedbackSettings.successColor;
        else if (options.colorType === 'error') backgroundColor = feedbackSettings.errorColor;
    }
    if (!backgroundColor) return;

    var borderColor = '';
    try {
        borderColor = getComputedStyle(document.querySelector('.s .h .l') || document.body).color || '';
    } catch (e) {}
    if (!borderColor || borderColor === 'rgba(0, 0, 0, 0)' || borderColor === 'transparent') borderColor = '#5C0D12';

    var borderWidth = (state && state.computedBorderWidth && state.computedBorderWidth !== '0px')
        ? state.computedBorderWidth
        : '1px';

    el.style.setProperty('background', backgroundColor, 'important');
    el.style.setProperty('background-color', backgroundColor, 'important');
    el.style.setProperty('color', '#FFFFFF', 'important');
    el.style.setProperty('border-style', 'solid', 'important');
    el.style.setProperty('border-width', borderWidth, 'important');
    el.style.setProperty('border-color', borderColor, 'important');
}

function _beginFeedbackState(el, options) {
    if (!el) return null;
    if (el.__feedbackController && typeof el.__feedbackController.restore === 'function') {
        el.__feedbackController.restore();
    }

    var state = _captureFeedbackElementState(el);
    if (options && options.restoreText !== undefined) {
        state.text = options.restoreText;
    }

    _applyFeedbackElementState(el, state, options);

    var restored = false;
    var controller = {
        restore: function() {
            if (restored) return;
            restored = true;
            if (controller.timer) {
                clearTimeout(controller.timer);
                controller.timer = null;
            }
            _restoreFeedbackElementState(el, state);
            if (el.__feedbackController === controller) el.__feedbackController = null;
        },
        timer: null
    };

    el.__feedbackController = controller;

    if (options && typeof options.durationMs === 'number' && options.durationMs >= 0) {
        controller.timer = setTimeout(function() {
            controller.restore();
        }, options.durationMs);
    }

    return controller;
}

function _flashFeedbackState(el, options) {
    options = options || {};
    if (typeof options.durationMs !== 'number' || options.durationMs < 0) {
        options.durationMs = _getConfirmFeedbackSettingsSafe().delayMs;
    }
    return _beginFeedbackState(el, options);
}

function flashColoredSuccessState(el, text, restoreText, delayMs) {
    return _flashFeedbackState(el, {
        text: text,
        restoreText: restoreText,
        durationMs: delayMs,
        useColor: true,
        colorType: 'success'
    });
}

function flashColoredErrorState(el, text, restoreText, delayMs) {
    return _flashFeedbackState(el, {
        text: text,
        restoreText: restoreText,
        durationMs: delayMs,
        useColor: true,
        colorType: 'error'
    });
}

function flashCustomColoredState(el, text, restoreText, delayMs, backgroundColor) {
    return _flashFeedbackState(el, {
        text: text,
        restoreText: restoreText,
        durationMs: delayMs,
        useColor: true,
        backgroundColor: backgroundColor
    });
}

function flashButtonSavedState(btn, doneText, revertText, delayMs) {
    if (!btn) return;

    var restoreText = revertText !== undefined ? revertText : _getFeedbackElementText(btn);
    var text = doneText || '已保存 ✓';
    var durationMs = delayMs || 1500;

    if (restoreText === 'Save' || restoreText === 'All Save') {
        text = '✓';
        durationMs = 1000;
    }

    return _flashFeedbackState(btn, {
        text: text,
        restoreText: restoreText,
        durationMs: durationMs,
        useColor: false
    });
}

function flashButtonErrorState(btn, errText, revertText, delayMs) {
    if (!btn) return;

    var restoreText = revertText !== undefined ? revertText : _getFeedbackElementText(btn);

    if (restoreText === 'All Save') {
        return flashColoredErrorState(btn, 'Fail', 'All Save', delayMs || _getConfirmFeedbackSettingsSafe().delayMs);
    }

    return _flashFeedbackState(btn, {
        text: errText || '失敗',
        restoreText: restoreText,
        durationMs: delayMs || 1500,
        useColor: false
    });
}

function refreshDictManagerPanels() {
    if (_dictManagerRefreshFns.kuromoji) _dictManagerRefreshFns.kuromoji();
    if (_dictManagerRefreshFns.jmdict) _dictManagerRefreshFns.jmdict();
}

function refreshShowFileListPanelIfOpen() {
    var panel = document.querySelector('.show-file-list-container');
    if (panel && typeof panel.refreshPanel === 'function') panel.refreshPanel();
}

function refreshOpenDictManagerPanelIfOpen() {
    var panel = document.querySelector('.dict-manager-container');
    if (panel && typeof panel.refreshPanel === 'function') panel.refreshPanel();
}

function getUserDictsRaw() {
    var dicts = {};
    try {
        dicts = GM_getValue('user_dicts', {});
    } catch (e) {}
    if (!dicts || typeof dicts !== 'object' || Array.isArray(dicts)) dicts = {};
    return dicts;
}

function setUserDictsRaw(dicts) {
    GM_setValue('user_dicts', dicts || {});
}

function getCommentTemplatesSafe() {
    try {
        var v = GM_getValue('comment_templates', []);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

function saveCommentTemplatesSafe(arr) {
    GM_setValue('comment_templates', Array.isArray(arr) ? arr : []);
}

function getFileListsSafe() {
    try {
        var v = GM_getValue('file_lists', {});
        return (v && typeof v === 'object') ? v : {};
    } catch (e) {
        return {};
    }
}

function saveFileListsSafe(fileLists) {
    GM_setValue('file_lists', fileLists || {});
}

function getGalleryFileLeafNameFromPath(path) {
    path = String(path || '');
    if (!path) return '';
    var parts = path.split('/');
    return parts.length ? String(parts[parts.length - 1] || '') : '';
}

function normalizeGalleryFileListEntry(fileEntry) {
    fileEntry = fileEntry || {};

    var originalPath = String(fileEntry.originalPath || fileEntry.path || '');
    var originalName = String(fileEntry.originalName || fileEntry.name || getGalleryFileLeafNameFromPath(originalPath) || '');
    var uploadName = String(fileEntry.uploadName || fileEntry.currentName || fileEntry.renamedName || fileEntry.displayName || originalName || '');

    if (!originalPath && originalName) originalPath = originalName;
    if (!originalName && originalPath) originalName = getGalleryFileLeafNameFromPath(originalPath);
    if (!uploadName) uploadName = originalName;

    return {
        name: originalName,
        path: originalPath,
        originalName: originalName,
        originalPath: originalPath,
        uploadName: uploadName
    };
}

function normalizeGalleryFileListEntries(files) {
    return Array.isArray(files) ? files.map(normalizeGalleryFileListEntry) : [];
}

function getGalleryFileUploadName(fileEntry) {
    return normalizeGalleryFileListEntry(fileEntry).uploadName;
}

function normalizeGalleryRootSources(rootSources, sourceType, sourceLabel) {
    var seen = {};
    var normalized = [];

    function pushSource(name, type) {
        name = String(name || '').trim();
        if (!name) return;
        type = type === 'folder' ? 'folder' : 'archive';
        var key = type + '::' + name;
        if (seen[key]) return;
        seen[key] = true;
        normalized.push({ name: name, type: type });
    }

    if (Array.isArray(rootSources)) {
        rootSources.forEach(function(item) {
            if (!item) return;
            if (typeof item === 'string') pushSource(item, sourceType);
            else pushSource(item.name, item.type || sourceType);
        });
    }

    if (!normalized.length && sourceLabel) {
        pushSource(sourceLabel, sourceType);
    }

    return normalized;
}

function getArchiveSourceLabelFromResult(result) {
    var label = String((result && (result.sourceLabel || result.title)) || '').trim();
    if (!label) return 'archive.zip';
    return /\.zip$/i.test(label) ? label : (label + '.zip');
}

function createGallerySourcePrefixedFileEntries(files, rootName) {
    rootName = String(rootName || '').trim();
    return normalizeGalleryFileListEntries(files).map(function(fileEntry) {
        var normalized = normalizeGalleryFileListEntry(fileEntry);
        var originalPath = String(normalized.originalPath || '').trim();
        var displayPath = String(normalized.path || '').trim();
        var basePath = originalPath || displayPath || String(normalized.originalName || '').trim();

        if (!basePath) return normalized;

        if (!originalPath) normalized.originalPath = basePath;
        normalized.path = rootName ? (rootName + '/' + basePath) : basePath;
        return normalized;
    });
}

function createRenamedUploadFile(fileObj, uploadName) {
    if (!fileObj) return fileObj;

    uploadName = String(uploadName || '').trim();
    if (!uploadName || uploadName === fileObj.name) return fileObj;

    try {
        return new File([fileObj], uploadName, {
            type: fileObj.type,
            lastModified: fileObj.lastModified
        });
    } catch (e) {
        try {
            return new File([fileObj], uploadName, {
                type: fileObj.type
            });
        } catch (e2) {
            return fileObj;
        }
    }
}

function readGalleryFileListById(galleryId) {
    var fileLists = getFileListsSafe();
    var data = fileLists[galleryId];
    if (Array.isArray(data)) {
        return {
            folderName: null,
            sourceType: null,
            sourceLabel: null,
            rootSources: [],
            authorizedRootId: null,
            files: normalizeGalleryFileListEntries(data.slice())
        };
    }
    if (data && data.files && Array.isArray(data.files)) {
        var rootSources = normalizeGalleryRootSources(
            data.rootSources,
            data.sourceType || (data.folderName ? 'folder' : null),
            data.sourceLabel || data.folderName || null
        );
        return {
            folderName: data.folderName || null,
            sourceType: rootSources[0] ? rootSources[0].type : (data.sourceType || null),
            sourceLabel: rootSources[0] ? rootSources[0].name : (data.sourceLabel || null),
            rootSources: rootSources,
            authorizedRootId: data.authorizedRootId || null,
            files: normalizeGalleryFileListEntries(data.files.slice())
        };
    }
    return {
        folderName: null,
        sourceType: null,
        sourceLabel: null,
        rootSources: [],
        authorizedRootId: null,
        files: []
    };
}

function writeGalleryFileListById(galleryId, folderName, files, sourceType, sourceLabel, rootSources, authorizedRootId) {
    var fileLists = getFileListsSafe();
    var existing = fileLists[galleryId] || {};
    var normalizedRootSources = normalizeGalleryRootSources(
        rootSources != null ? rootSources : existing.rootSources,
        sourceType != null ? sourceType : existing.sourceType,
        sourceLabel != null ? sourceLabel : existing.sourceLabel
    );

    if (!normalizedRootSources.length && (folderName || existing.folderName)) {
        normalizedRootSources = normalizeGalleryRootSources(null, 'folder', folderName || existing.folderName);
    }

    var primarySource = normalizedRootSources[0] || null;

    fileLists[galleryId] = {
        folderName: folderName || existing.folderName || null,
        sourceType: primarySource ? primarySource.type : (sourceType != null ? sourceType : (existing.sourceType || null)),
        sourceLabel: primarySource ? primarySource.name : (sourceLabel != null ? sourceLabel : (existing.sourceLabel || null)),
        rootSources: normalizedRootSources,
        authorizedRootId: authorizedRootId != null ? authorizedRootId : (existing.authorizedRootId || null),
        files: normalizeGalleryFileListEntries(files)
    };
    saveFileListsSafe(fileLists);
}

function deleteGalleryFileListById(galleryId) {
    var fileLists = getFileListsSafe();
    delete fileLists[galleryId];
    saveFileListsSafe(fileLists);
}

function getSavedGalleriesSafe() {
    try {
        var v = GM_getValue('saved_galleries', []);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

function saveSavedGalleriesSafe(galleries) {
    GM_setValue('saved_galleries', Array.isArray(galleries) ? galleries : []);
}

function upsertSavedGallery(galleryData) {
    var galleries = getSavedGalleriesSafe().filter(function(g) {
        return g && g.id !== galleryData.id;
    });
    galleries.push(galleryData);
    saveSavedGalleriesSafe(galleries);
}

function removeSavedGalleryById(galleryId) {
    var galleries = getSavedGalleriesSafe().filter(function(g) {
        return g && g.id !== galleryId;
    });
    saveSavedGalleriesSafe(galleries);
}

function syncAllCommentTemplateDropdowns() {
    var selects = document.querySelectorAll('select.comment-template-select');
    var templates = getCommentTemplatesSafe();
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

function hasAllExternalDictsDownloaded() {
    return hasAllExternalDictsDownloadedRewritten();
    return checkAllDictsInIDB().then(function(allCached) {
        if (!allCached) return false;
        return dbGet('dicts', 'jmdict_data').then(function(data) {
            return Array.isArray(data) && data.length > 0;
        });
    });
}

function triggerExternalDictUpdate(btn) {
    var runnerBtn = btn || { disabled: false, textContent: '' };
    if (!_dictManagerUpdateFn) { createDictManagerPanel(); }
    if (!_dictManagerUpdateFn) {
        return Promise.reject(new Error('updateAllDicts is not defined'));
    }
    try {
        _dictManagerUpdateFn(runnerBtn);
    } catch (err) {
        refreshDictManagerPanels();
        return Promise.reject(err);
    }
    return new Promise(function(resolve, reject) {
        var started = false;
        var ticks = 0;
        function check() {
            ticks++;
            if (runnerBtn.disabled) started = true;
            if (started && !runnerBtn.disabled) {
                resolve(true);
                return;
            }
            if (ticks >= 600) {
                reject(new Error('external dict update timeout'));
                return;
            }
            setTimeout(check, 200);
        }
        setTimeout(check, 200);
    }).then(function(result) {
        refreshDictManagerPanels();
        return result;
    }).catch(function(err) {
        refreshDictManagerPanels();
        throw err;
    });
}

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
        flowLog('Dict', '下載開始', fileName);
        GM_xmlhttpRequest({
            method: 'GET',
            url: KUROMOJI_DICT_CDN + fileName,
            responseType: 'arraybuffer',
            onload: function(resp) {
                if (resp.status >= 200 && resp.status < 300) {
                    flowLog('Dict', '下載完成', { file: fileName, size: resp.response.byteLength });
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
        flowLog('Dict', 'Blob URL 建立完成', { count: entries.length });
        return map;
    });
}

function initKuroshiro() {
    if (_kuroshiroInitPromise) return _kuroshiroInitPromise;
    _kuroshiroInitPromise = _initKuroshiroInternal();
    return _kuroshiroInitPromise;
}

function _initKuroshiroInternal() {
    flowLog('Kuroshiro', '開始初始化');
    _debug('[Kuroshiro] typeof Kuroshiro:', typeof Kuroshiro);
    _debug('[Kuroshiro] typeof KuromojiAnalyzer:', typeof KuromojiAnalyzer);

    var KuroshiroClass = (typeof Kuroshiro !== 'undefined') ? (Kuroshiro.default || Kuroshiro) : null;
    var AnalyzerClass = (typeof KuromojiAnalyzer !== 'undefined') ? (KuromojiAnalyzer.default || KuromojiAnalyzer) : null;

    if (!KuroshiroClass) {
        errorLog('Kuroshiro', 'Kuroshiro 未定義');
        return Promise.resolve(false);
    }
    if (!AnalyzerClass) {
        errorLog('Kuroshiro', 'KuromojiAnalyzer 未定義');
        return Promise.resolve(false);
    }

    return checkAllDictsInIDB().then(function(allCached) {
        if (allCached) {
            flowLog('Kuroshiro', '字典已緩存，直接從 IndexedDB 載入');
            return Promise.resolve();
        }
        flowLog('Kuroshiro', '字典未緩存，開始下載');
        var downloaded = 0;
        var total = KUROMOJI_DICT_FILES.length;
        return KUROMOJI_DICT_FILES.reduce(function(chain, fileName) {
            return chain.then(function() {
                return downloadDictFile(fileName, function() {
                    downloaded++;
                    flowLog('Dict', '下載進度', downloaded + '/' + total + ' ' + fileName);
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
            if (matched) _debug('[Dict] XHR 攔截 →', url.substring(0, 50));
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
            flowLog('Kuroshiro', '初始化完成');
            KUROMOJI_DICT_FILES.forEach(function(f) {
                if (blobMap[f]) URL.revokeObjectURL(blobMap[f]);
            });
            return true;
        }).catch(function(err) {
            XMLHttpRequest.prototype.open = origOpen;
            XMLHttpRequest.prototype.send = origSend;
            errorLog('Kuroshiro', 'init 失敗', err.message || err);
            _kuroshiroInitPromise = null;
            return false;
        });
    }).catch(function(err) {
        errorLog('Kuroshiro', '初始化例外', err.message || err);
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

function normalizeAuthorizedRootHandleEntries(entries) {
    var source = Array.isArray(entries) ? entries : [];
    var out = [];
    var seen = {};

    source.forEach(function(item) {
        if (!item) return;

        var id = String(item.id || '').trim();
        if (!id || seen[id]) return;
        seen[id] = true;

        var label = String(item.label || '').trim();
        if (!label) label = '授權文件夾 ' + (out.length + 1);

        out.push({
            id: id,
            label: label,
            handle: item.handle || null
        });
    });

    return out;
}

function getAuthorizedRootHandleEntriesRaw() {
    return dbGet('handles', 'authorized_root_handles').then(function(entries) {
        return normalizeAuthorizedRootHandleEntries(entries);
    }).catch(function() {
        return [];
    });
}

function setAuthorizedRootHandleEntriesRaw(entries) {
    return dbSet('handles', 'authorized_root_handles', normalizeAuthorizedRootHandleEntries(entries));
}

function getAuthorizedRootEntriesDetailed() {
    var settings = migrateAuthorizedFolderSettings(getCurrentSettingsSafe());

    return getAuthorizedRootHandleEntriesRaw().then(function(handleEntries) {
        var handleMap = {};
        handleEntries.forEach(function(item) {
            handleMap[item.id] = item;
        });

        var mergedEntries = settings.customAuthorizedFolders.map(function(folder) {
            var matched = handleMap[folder.id] || null;
            return {
                id: folder.id,
                label: folder.label,
                handle: matched ? matched.handle : null
            };
        });

        handleEntries.forEach(function(item) {
            var exists = mergedEntries.some(function(entry) {
                return entry.id === item.id;
            });
            if (!exists) {
                mergedEntries.push({
                    id: item.id,
                    label: item.label,
                    handle: item.handle || null
                });
            }
        });

        return Promise.all(mergedEntries.map(function(entry) {
            if (!entry.handle || !entry.handle.queryPermission) {
                return Object.assign({}, entry, {
                    status: 'missing',
                    statusText: '未授權'
                });
            }

            return Promise.resolve().then(function() {
                return entry.handle.queryPermission({ mode: 'read' });
            }).then(function(permission) {
                return Object.assign({}, entry, {
                    status: permission === 'granted' ? 'granted' : 'prompt',
                    statusText: permission === 'granted' ? '✓ 已授權' : '未授權'
                });
            }).catch(function(err) {
                return Object.assign({}, entry, {
                    status: 'error',
                    statusText: '已失效',
                    error: err && (err.message || String(err))
                });
            });
        }));
    });
}

function persistAuthorizedRootEntries(entries, baseSettings) {
    var sourceEntries = Array.isArray(entries) ? entries : [];
    var normalizedMeta = normalizeAuthorizedFolderSettingsList(sourceEntries.map(function(item) {
        return {
            id: item && item.id,
            label: item && item.label
        };
    }));

    var handleMap = {};
    sourceEntries.forEach(function(item) {
        if (!item) return;
        var id = String(item.id || '').trim();
        if (!id || !item.handle) return;
        handleMap[id] = item.handle;
    });

    var normalizedHandleEntries = normalizedMeta.map(function(item) {
        return {
            id: item.id,
            label: item.label,
            handle: handleMap[item.id] || null
        };
    }).filter(function(item) {
        return !!item.handle;
    });

    var nextSettings = migrateAuthorizedFolderSettings(Object.assign(
        {},
        getCurrentSettingsSafe(),
        baseSettings || {},
        {
            customAuthorizedFolders: normalizedMeta
        }
    ));

    saveSettings(nextSettings);

    return setAuthorizedRootHandleEntriesRaw(normalizedHandleEntries).then(function() {
        return nextSettings;
    });
}

function migrateLegacyAuthorizedRootFolderState() {
    return Promise.all([
        dbGet('handles', 'root_folder_handle').catch(function() { return null; }),
        getAuthorizedRootHandleEntriesRaw().catch(function() { return []; })
    ]).then(function(results) {
        var legacyHandle = results[0];
        var handleEntries = normalizeAuthorizedRootHandleEntries(results[1]);
        var settingsToPersist = migrateAuthorizedFolderSettings(getCurrentSettingsSafe());
        var changedSettings = false;
        var changedHandles = false;

        if (!settingsToPersist.customAuthorizedFolders.length && legacyHandle) {
            settingsToPersist = migrateAuthorizedFolderSettings(Object.assign({}, settingsToPersist, {
                customAuthorizedFolders: [
                    {
                        id: _generateAuthorizedFolderId(),
                        label: legacyHandle.name || '授權文件夾 1'
                    }
                ]
            }));
            changedSettings = true;
        }

        if (legacyHandle && settingsToPersist.customAuthorizedFolders.length) {
            var firstFolder = settingsToPersist.customAuthorizedFolders[0];
            var alreadyMapped = handleEntries.some(function(item) {
                return item.id === firstFolder.id;
            });

            if (!alreadyMapped) {
                handleEntries.push({
                    id: firstFolder.id,
                    label: firstFolder.label,
                    handle: legacyHandle
                });
                changedHandles = true;
            }
        }

        handleEntries = normalizeAuthorizedRootHandleEntries(handleEntries.map(function(item) {
            var matchedMeta = settingsToPersist.customAuthorizedFolders.find(function(folder) {
                return folder.id === item.id;
            });
            if (matchedMeta && item.label !== matchedMeta.label) {
                changedHandles = true;
                return {
                    id: item.id,
                    label: matchedMeta.label,
                    handle: item.handle
                };
            }
            return item;
        }));

        if (changedSettings) saveSettings(settingsToPersist);
        if (!changedHandles) return null;
        return setAuthorizedRootHandleEntriesRaw(handleEntries);
    });
}

function createAuthorizedSelectionError(code, message) {
    var err = new Error(message || code || 'AUTHORIZED_SELECTION_ERROR');
    err.code = code || 'AUTHORIZED_SELECTION_ERROR';
    return err;
}

function getAuthorizedSelectionErrorMessage(code, targetLabel) {
    targetLabel = String(targetLabel || '項目');

    if (code === 'NO_AUTHORIZED_ROOTS') return '尚未設定授權文件夾';
    if (code === 'AUTHORIZED_ROOT_PERMISSION_DENIED') return '授權文件夾讀取權限失效';
    if (code === 'PICKER_UNSUPPORTED') return '目前瀏覽器不支援檔案選擇器';
    if (code === 'PICKER_INVOCATION_FAILED') return '檔案選擇器呼叫失敗';
    if (code === 'EMPTY_SELECTION') return '未選擇任何' + targetLabel;
    if (code === 'NOT_IN_AUTHORIZED_FOLDER') return targetLabel + '不在已授權文件夾內';

    return targetLabel + '授權檢查失敗';
}

function getAuthorizedSelectionFailureDisplayMessage(err, targetLabel) {
    var code = err && err.code;
    targetLabel = String(targetLabel || '項目');

    if (code === 'NO_AUTHORIZED_ROOTS') return '導入失敗：尚未設定授權文件夾';
    if (code === 'AUTHORIZED_ROOT_PERMISSION_DENIED') return '導入失敗：授權文件夾權限失效';
    if (code === 'PICKER_UNSUPPORTED') return '導入失敗：瀏覽器不支援檔案選擇器';
    if (code === 'PICKER_INVOCATION_FAILED') return '導入失敗：檔案選擇器呼叫失敗';
    if (code === 'NOT_IN_AUTHORIZED_FOLDER') return '導入失敗：不在已授權文件夾內';
    if (code === 'EMPTY_SELECTION' || (err && err.name === 'AbortError')) return '已取消選擇' + targetLabel;

    return '導入失敗：授權檢查失敗';
}

function findDescendantHandlePathByScan(directoryHandle, targetHandle, prefixParts) {
    prefixParts = Array.isArray(prefixParts) ? prefixParts.slice() : [];
    if (!directoryHandle || !targetHandle || !directoryHandle.values) return Promise.resolve(null);

    var iterator = null;
    try {
        iterator = directoryHandle.values();
    } catch (e) {
        return Promise.resolve(null);
    }

    function processNext() {
        return iterator.next().then(function(result) {
            if (result.done) return null;

            var entry = result.value;
            if (!entry) return processNext();

            if (entry.kind === 'file') {
                if (!entry.isSameEntry) return processNext();
                return Promise.resolve(entry.isSameEntry(targetHandle)).catch(function() {
                    return false;
                }).then(function(isSame) {
                    if (isSame) return prefixParts.concat([entry.name]);
                    return processNext();
                });
            }

            if (entry.kind === 'directory') {
                return Promise.resolve(entry.isSameEntry ? entry.isSameEntry(targetHandle) : false).catch(function() {
                    return false;
                }).then(function(isSameDirectory) {
                    if (isSameDirectory) return prefixParts.concat([entry.name]);
                    return findDescendantHandlePathByScan(entry, targetHandle, prefixParts.concat([entry.name]));
                }).then(function(found) {
                    if (found) return found;
                    return processNext();
                });
            }

            return processNext();
        }).catch(function() {
            return null;
        });
    }

    return processNext();
}

function requestReadPermissionIfNeeded(handle) {
    if (!handle) return Promise.resolve(false);

    return Promise.resolve().then(function() {
        if (!handle.queryPermission) return true;
        return handle.queryPermission({ mode: 'read' });
    }).then(function(permission) {
        if (permission === true || permission === 'granted') return true;
        if (!handle.requestPermission) return false;
        return handle.requestPermission({ mode: 'read' }).then(function(nextPermission) {
            return nextPermission === true || nextPermission === 'granted';
        }).catch(function() {
            return false;
        });
    }).catch(function() {
        return false;
    });
}

function buildAuthorizedRelativePathFromParts(parts) {
    return Array.isArray(parts) && parts.length ? parts.join('/') : '';
}

function resolveHandleAgainstDirectoryHandle(directoryHandle, targetHandle) {
    if (!directoryHandle || !targetHandle) return Promise.resolve(null);

    return Promise.resolve().then(function() {
        if (!directoryHandle.isSameEntry || !targetHandle.isSameEntry) return false;
        return directoryHandle.isSameEntry(targetHandle);
    }).catch(function() {
        return false;
    }).then(function(isSame) {
        if (isSame) return [];
        if (!directoryHandle.resolve) return null;
        return Promise.resolve(directoryHandle.resolve(targetHandle)).catch(function() {
            return null;
        });
    }).then(function(relativePathParts) {
        if (Array.isArray(relativePathParts)) return relativePathParts;
        return findDescendantHandlePathByScan(directoryHandle, targetHandle, []);
    }).then(function(relativePathParts) {
        return Array.isArray(relativePathParts) ? relativePathParts : null;
    });
}

function findAuthorizedRootMatchForHandle(targetHandle) {
    return getAuthorizedRootHandleEntriesRaw().then(function(entries) {
        var activeEntries = entries.filter(function(entry) {
            return !!(entry && entry.handle);
        });

        if (activeEntries.length) return activeEntries;

        return dbGet('handles', 'root_folder_handle').catch(function() {
            return null;
        }).then(function(legacyHandle) {
            if (!legacyHandle) return [];
            return [
                {
                    id: 'legacy_root_folder_handle',
                    label: legacyHandle.name || '授權文件夾',
                    handle: legacyHandle
                }
            ];
        });
    }).then(function(activeEntries) {
        if (!activeEntries.length) {
            return {
                entry: null,
                relativePathParts: null,
                failureCode: 'NO_AUTHORIZED_ROOTS'
            };
        }

        var hadReadableRoot = false;

        function tryNext(index) {
            if (index >= activeEntries.length) {
                return {
                    entry: null,
                    relativePathParts: null,
                    failureCode: hadReadableRoot ? 'NOT_IN_AUTHORIZED_FOLDER' : 'AUTHORIZED_ROOT_PERMISSION_DENIED'
                };
            }

            var entry = activeEntries[index];
            return requestReadPermissionIfNeeded(entry.handle).then(function(canRead) {
                if (!canRead) return tryNext(index + 1);

                hadReadableRoot = true;

                return resolveHandleAgainstDirectoryHandle(entry.handle, targetHandle).then(function(relativePathParts) {
                    if (relativePathParts === null) return tryNext(index + 1);
                    return {
                        entry: entry,
                        relativePathParts: Array.isArray(relativePathParts) ? relativePathParts : [],
                        failureCode: null
                    };
                });
            }).catch(function() {
                return tryNext(index + 1);
            });
        }

        return tryNext(0);
    });
}

function getAuthorizedRootHandleByIdOrLegacy(authorizedRootId) {
    var id = String(authorizedRootId || '').trim();

    if (!id) {
        return dbGet('handles', 'root_folder_handle').catch(function() {
            return null;
        });
    }

    return getAuthorizedRootHandleEntriesRaw().then(function(entries) {
        var matched = entries.find(function(entry) {
            return entry.id === id && entry.handle;
        });
        return matched ? matched.handle : null;
    }).then(function(handle) {
        if (handle) return handle;
        return dbGet('handles', 'root_folder_handle').catch(function() {
            return null;
        });
    });
}

function resolveFileObjectFromDirectoryHandlePath(rootHandle, relativePath) {
    var parts = String(relativePath || '').split('/').filter(function(part) {
        return !!part;
    });

    if (!rootHandle || !parts.length) {
        return Promise.reject(createAuthorizedSelectionError('INVALID_FILE_PATH', 'invalid file path'));
    }

    function walk(handle, index) {
        var part = parts[index];
        if (index === parts.length - 1) {
            return handle.getFileHandle(part).then(function(fileHandle) {
                return fileHandle.getFile();
            });
        }

        return handle.getDirectoryHandle(part).then(function(nextHandle) {
            return walk(nextHandle, index + 1);
        });
    }

    return walk(rootHandle, 0);
}

function getAuthorizedArchivePickerTypes() {
    return [
        {
            description: 'ZIP Archives',
            accept: {
                'application/zip': ['.zip'],
                'application/octet-stream': ['.zip', '.z01', '.z02', '.z03', '.z04', '.z05', '.z06', '.z07', '.z08', '.z09']
            }
        }
    ];
}

function selectAuthorizedArchiveFilesWithPicker() {
    var pickerHost = null;

    try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.showOpenFilePicker === 'function') {
            pickerHost = unsafeWindow;
        }
    } catch (e) {}

    if (!pickerHost && typeof window.showOpenFilePicker === 'function') {
        pickerHost = window;
    }

    if (!pickerHost) {
        return Promise.reject(createAuthorizedSelectionError(
            'PICKER_UNSUPPORTED',
            getAuthorizedSelectionErrorMessage('PICKER_UNSUPPORTED', '壓縮檔')
        ));
    }

    return Promise.resolve().then(function() {
        return pickerHost.showOpenFilePicker.call(pickerHost, {
            multiple: true,
            types: getAuthorizedArchivePickerTypes()
        });
    }).catch(function(err) {
        if (err && err.name === 'AbortError') throw err;
        if (err && err.code) throw err;
        throw createAuthorizedSelectionError(
            'PICKER_INVOCATION_FAILED',
            getAuthorizedSelectionErrorMessage('PICKER_INVOCATION_FAILED', '壓縮檔') +
                (err && err.message ? '：' + err.message : '')
        );
    }).then(function(handles) {
        if (!handles || !handles.length) {
            throw createAuthorizedSelectionError(
                'EMPTY_SELECTION',
                getAuthorizedSelectionErrorMessage('EMPTY_SELECTION', '壓縮檔')
            );
        }

        return Promise.all(handles.map(function(handle) {
            return findAuthorizedRootMatchForHandle(handle).then(function(matchResult) {
                var failureCode = (matchResult && matchResult.failureCode) || 'NOT_IN_AUTHORIZED_FOLDER';
                if (!matchResult || !matchResult.entry) {
                    throw createAuthorizedSelectionError(
                        failureCode,
                        getAuthorizedSelectionErrorMessage(failureCode, '壓縮檔')
                    );
                }

                return {
                    handle: handle,
                    authorizedRootEntry: matchResult.entry,
                    relativePathParts: matchResult.relativePathParts || []
                };
            });
        })).then(function(items) {
            return Promise.all(items.map(function(item) {
                return item.handle.getFile();
            })).then(function(files) {
                return {
                    files: files,
                    items: items
                };
            });
        });
    });
}

function selectAuthorizedDirectoryWithPicker() {
    var pickerHost = null;

    try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.showDirectoryPicker === 'function') {
            pickerHost = unsafeWindow;
        }
    } catch (e) {}

    if (!pickerHost && typeof window.showDirectoryPicker === 'function') {
        pickerHost = window;
    }

    if (!pickerHost) {
        return Promise.reject(createAuthorizedSelectionError(
            'PICKER_UNSUPPORTED',
            getAuthorizedSelectionErrorMessage('PICKER_UNSUPPORTED', '文件夾')
        ));
    }

    return Promise.resolve().then(function() {
        return pickerHost.showDirectoryPicker.call(pickerHost, { mode: 'read' });
    }).catch(function(err) {
        if (err && err.name === 'AbortError') throw err;
        if (err && err.code) throw err;
        throw createAuthorizedSelectionError(
            'PICKER_INVOCATION_FAILED',
            getAuthorizedSelectionErrorMessage('PICKER_INVOCATION_FAILED', '文件夾') +
                (err && err.message ? '：' + err.message : '')
        );
    }).then(function(handle) {
        return findAuthorizedRootMatchForHandle(handle).then(function(matchResult) {
            var failureCode = (matchResult && matchResult.failureCode) || 'NOT_IN_AUTHORIZED_FOLDER';
            if (!matchResult || !matchResult.entry) {
                throw createAuthorizedSelectionError(
                    failureCode,
                    getAuthorizedSelectionErrorMessage(failureCode, '文件夾')
                );
            }
            return {
                handle: handle,
                authorizedRootEntry: matchResult.entry,
                relativePathParts: matchResult.relativePathParts || []
            };
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
        flowLog('驗證', '過濾不支持格式', name);
        return false;
    }
    if (size !== undefined && FILE_LIMITS[ext] && size > FILE_LIMITS[ext]) {
        warnLog('驗證', '文件超過大小限制', { name: name, size: size, limit: FILE_LIMITS[ext] });
        return false;
    }
    return true;
}

// ==================== handleManageGalleryPage ====================

function handleManageGalleryPage() {
    if (!window.location.pathname.includes('/managegallery')) return;

    flowLog('AutoCreate', 'handleManageGalleryPage 開始', window.location.href);

    var data = GM_getValue('pending_create', null);
    var isFromQueue = false;
    if (!data) {
        var queue = GM_getValue('pending_create_queue', []);
        if (queue.length > 0) {
            data = queue.shift();
            GM_setValue('pending_create_queue', queue);
            isFromQueue = true;
            flowLog('AutoCreate', '從 queue 取得', { id: data ? data.id : 'null', remain: queue.length });
        }
    }
    _debug('[AutoCreate] pending_create:', data ? data.id : 'null');

    if (!data) {
        flowLog('AutoCreate', '無 pending_create，退出');
        return;
    }
    if (!isFromQueue) { GM_setValue('pending_create', null); }
    flowLog('AutoCreate', 'pending_create 已清除');

    var filled = false;

    function fillForm() {
        if (filled) {
            _debug('[AutoCreate] 已填過，跳過');
            return;
        }

        var gnameEn = document.getElementById('gname_en');
        var saveBtn = document.getElementById('savebutton');

        if (!gnameEn || !saveBtn) {
            _debug('[AutoCreate] 表單元素尚未就緒，等待中...');
            return;
        }

        filled = true;
        flowLog('AutoCreate', '開始填表');

        var titleParts = buildTitleSuffix(data);
        var mainTitle = data.title1 || '';
        var jpTitle = data.title2 || '';
        if (mainTitle && !jpTitle) jpTitle = mainTitle;
        else if (!mainTitle && jpTitle) mainTitle = jpTitle;

        gnameEn.value = titleParts.mainPrefix + mainTitle + titleParts.mainSuffix;
        gnameEn.dispatchEvent(new Event('input', { bubbles: true }));
        _debug('[AutoCreate] gname_en =', gnameEn.value);

        var gnameJp = document.getElementById('gname_jp');
        if (gnameJp) {
            gnameJp.value = titleParts.jpPrefix + jpTitle + titleParts.jpSuffix;
            _debug('[AutoCreate] gname_jp =', gnameJp.value);
        }

        var categorySelect = document.getElementById('category');
        if (categorySelect) {
            Array.from(categorySelect.options).forEach(function(opt) {
                if (opt.value === data.category) {
                    opt.selected = true;
                    _debug('[AutoCreate] category =', opt.value, opt.text);
                }
            });
        }

        var langSelect = document.getElementById('langtag');
        if (langSelect) {
            Array.from(langSelect.options).forEach(function(opt) {
                if (opt.value === data.language) {
                    opt.selected = true;
                    _debug('[AutoCreate] langtag =', opt.value, opt.text);
                }
            });
            langSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        var langTypeVal = data.langtype || '0';
        var langTypeRadio = document.getElementById('langtype_' + langTypeVal);
        if (langTypeRadio) {
            langTypeRadio.checked = true;
            langTypeRadio.dispatchEvent(new Event('change', { bubbles: true }));
            _debug('[AutoCreate] langtype =', langTypeVal);
        }

        var langCtl = document.getElementById('langctl');
        if (langCtl && langTypeVal === '1') {
            langCtl.checked = !data.mtl;
            _debug('[AutoCreate] langctl =', langCtl.checked);
        }

        var folderSelect = document.getElementById('folderid');
        if (folderSelect) {
            var folderMatched = false;
            Array.from(folderSelect.options).forEach(function(opt) {
                if (opt.text.trim() === data.folder) {
                    opt.selected = true;
                    folderMatched = true;
                    _debug('[AutoCreate] folderid matched =', opt.value, opt.text);
                }
            });
            if (!folderMatched) {
                var folderName = document.getElementById('foldername');
                if (folderName && data.folder && data.folder !== 'Unsorted') {
                    folderName.value = data.folder;
                    _debug('[AutoCreate] foldername =', folderName.value);
                }
            }
        }

        var ulComment = document.getElementById('ulcomment');
        if (ulComment) {
            ulComment.value = data.comment || '';
            _debug('[AutoCreate] ulcomment 已填入');
        }

        var tos = document.getElementById('tos');
        if (tos && !tos.checked) {
            tos.click();
            _debug('[AutoCreate] tos 已點擊');
        } else if (tos) {
            _debug('[AutoCreate] tos 已是勾選狀態');
        }

        if (typeof update_tosstate === 'function') {
            update_tosstate();
            _debug('[AutoCreate] update_tosstate 已調用');
        }

        var xhrDone = false;
        var retryCount = 0;
        var maxRetry = currentSettings.retryCount || 3;
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._url = url;
            this._method = method;
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
            var xhr = this;
            xhr.addEventListener('load', function() {
                _debug('[AutoCreate] XHR load: status=', xhr.status, 'url=', xhr._url);
                if (xhr.status >= 200 && xhr.status < 300 && !xhrDone) {
                    var doc = new DOMParser().parseFromString(xhr.responseText, 'text/html');
                    var dateAdded = Array.from(doc.querySelectorAll('td.k')).find(function(td) {
                        return td.textContent.includes('Date Added');
                    });
                    var dateVal = dateAdded ? dateAdded.nextElementSibling : null;
                    _debug('[AutoCreate] Date Added:', dateVal ? dateVal.textContent : 'N/A');
                    if (dateVal && dateVal.textContent && !dateVal.textContent.includes('Not created')) {
                        xhrDone = true;
                        XMLHttpRequest.prototype.open = origOpen;
                        XMLHttpRequest.prototype.send = origSend;
                        opLog('圖庫創建成功', { savedDataId: data.savedDataId || null, title: data.title1 || data.title2 || '' });
                        if (data.savedDataId) {
                            GM_setValue('create_success', data.savedDataId);
                            _debug('[AutoCreate] create_success 已設置:', data.savedDataId);
                        }
                        var ulgidMatch = xhr.responseURL ? xhr.responseURL.match(/ulgid=(\d+)/) : null;
                        if (!ulgidMatch) {
                            var docUrl = doc.querySelector('a[href*="ulgid"]');
                            if (docUrl) ulgidMatch = docUrl.href.match(/ulgid=(\d+)/);
                        }
                        if (ulgidMatch && data.savedDataId) {
                            var ulgid = ulgidMatch[1];
                            flowLog('AutoCreate', '取得 ulgid，準備儲存上傳任務', ulgid);
                            var pendingUpload = { ulgid: ulgid, savedDataId: data.savedDataId };
                            GM_setValue('pending_upload', pendingUpload);
                            flowLog('AutoCreate', 'pending_upload 已儲存，準備跳轉');
                            setTimeout(function() {
                                window.location.href = 'https://upload.e-hentai.org/managegallery?ulgid=' + ulgid;
                            }, 800);
                        } else {
                            warnLog('AutoCreate', '無法取得 ulgid，跳過上傳');
                        }
                    } else {
                        retryCount++;
                        warnLog('AutoCreate', '圖庫創建未確認，重試', retryCount + '/' + maxRetry);
                        if (retryCount < maxRetry) {
                            setTimeout(function() {
                                var sb = document.getElementById('savebutton');
                                if (sb && !sb.disabled) {
                                    sb.click();
                                    _debug('[AutoCreate] 重試點擊 savebutton');
                                }
                            }, 2000);
                        }
                    }
                }
            });
            return origSend.apply(this, arguments);
        };

        _debug('[AutoCreate] 等待 savebutton 啟用...');
        var saveBtnClicked = false;
        var waitInterval = setInterval(function() {
            var sb = document.getElementById('savebutton');
            var tosEl = document.getElementById('tos');
            var gnEl = document.getElementById('gname_en');
            if (!sb) return;
            _debug('[AutoCreate] savebutton disabled =', sb.disabled, '| tos =', tosEl ? tosEl.checked : 'N/A', '| gname_en =', gnEl ? gnEl.value : 'N/A');
            if (!sb.disabled && tosEl && tosEl.checked && gnEl && gnEl.value && !saveBtnClicked) {
                saveBtnClicked = true;
                clearInterval(waitInterval);
                flowLog('AutoCreate', 'savebutton 已啟用，點擊中');
                sb.click();
                sb.disabled = true;
                _debug('[AutoCreate] savebutton 已點擊');
            }
        }, 300);
    }

    var checkInterval = setInterval(function() {
        if (document.getElementById('gname_en')) {
            clearInterval(checkInterval);
            fillForm();
        }
    }, 100);

    setTimeout(function() {
        clearInterval(checkInterval);
        if (!filled) {
            warnLog('AutoCreate', '超時，強制執行 fillForm');
            fillForm();
        }
    }, 5000);
}

// ==================== startFolderUpload ====================

function startFolderUpload(savedDataId) {
    flowLog('Upload', 'startFolderUpload 開始', savedDataId);

    var fileListEntry = readGalleryFileListById(savedDataId);
    if (!fileListEntry || !fileListEntry.files || fileListEntry.files.length === 0) {
        warnLog('Upload', '無文件列表，跳過上傳', savedDataId);
        return;
    }

    var files = fileListEntry.files;
    flowLog('Upload', '文件資訊', {
        folderName: fileListEntry.folderName || null,
        authorizedRootId: fileListEntry.authorizedRootId || null,
        count: files.length
    });

    if (fileListEntry.sourceType !== 'folder') {
        warnLog('Upload', '非文件夾來源，跳過上傳');
        return;
    }

    getAuthorizedRootHandleByIdOrLegacy(fileListEntry.authorizedRootId).then(function(rootHandle) {
        if (!rootHandle) {
            errorLog('Upload', '無已授權文件夾 handle，請在 Setting 中設定授權文件夾');
            return;
        }

        return requestReadPermissionIfNeeded(rootHandle).then(function(canRead) {
            if (!canRead) {
                errorLog('Upload', '授權文件夾無讀取權限');
                return;
            }

            var filePromises = files.map(function(fileEntry) {
                var sourcePath = String((fileEntry && (fileEntry.path || fileEntry.originalPath || fileEntry.name)) || '');
                var uploadName = getGalleryFileUploadName(fileEntry);

                if (!sourcePath) {
                    warnLog('Upload', '缺少原始檔案路徑，無法上傳', { fileEntry: fileEntry });
                    return Promise.resolve(null);
                }

                return resolveFileObjectFromDirectoryHandlePath(rootHandle, sourcePath).then(function(fileObj) {
                    return createRenamedUploadFile(fileObj, uploadName);
                }).catch(function(err) {
                    warnLog('Upload', '無法解析檔案', { path: sourcePath, message: err.message });
                    return null;
                });
            });

            return Promise.all(filePromises).then(function(fileObjs) {
                fileObjs = fileObjs.filter(function(f) { return f !== null; });
                flowLog('Upload', '成功解析 File 物件', fileObjs.length);
                if (fileObjs.length === 0) {
                    warnLog('Upload', '無有效 File 物件，跳過上傳');
                    return;
                }

                function waitForMultiUploadBtn(retries) {
                    if (retries <= 0) {
                        errorLog('Upload', 'Multi Upload 按鈕等待超時');
                        return;
                    }
                    var btn = Array.from(document.querySelectorAll('button')).find(function(b) {
                        return b.textContent.trim() === 'Multi Upload';
                    });
                    if (!btn) {
                        _debug('[Upload] 等待 Multi Upload 按鈕...');
                        setTimeout(function() { waitForMultiUploadBtn(retries - 1); }, 500);
                        return;
                    }
                    var parent = btn.parentElement;
                    var hiddenInput = parent ? Array.from(parent.querySelectorAll('input[type="file"]')).find(function(i) {
                        return i.style.display === 'none' && i.multiple;
                    }) : null;
                    if (!hiddenInput) {
                        _debug('[Upload] 等待 hiddenInput...');
                        setTimeout(function() { waitForMultiUploadBtn(retries - 1); }, 500);
                        return;
                    }
                    flowLog('Upload', '找到 Multi Upload hiddenInput，開始注入', fileObjs.length);
                    var dt = new DataTransfer();
                    fileObjs.forEach(function(f) { dt.items.add(f); });
                    hiddenInput.files = dt.files;
                    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
                    flowLog('Upload', 'change 事件已觸發，上傳腳本接管');
                }

                waitForMultiUploadBtn(20);
            });
        });
    }).catch(function(err) {
        errorLog('Upload', 'startFolderUpload 失敗', err);
    });
}

// ==================== UI 工具函數 ====================

function getStoredFolders() {
    try {
        var v = GM_getValue('scanned_folders', []);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
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
    try {
        var v = GM_getValue('local_folders', ['Waiting Create']);
        return Array.isArray(v) ? v : ['Waiting Create'];
    } catch (e) {
        return ['Waiting Create'];
    }
}

function saveLocalFolders(folders) {
    try {
        GM_setValue('local_folders', folders);
        opLog('保存本地資料夾列表', folders);
    } catch (e) {
        errorLog('LocalFolder', '保存失敗', e);
    }
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
    applyPageToneBtnStyle(btn, 'padding: 2px 8px;height: 20px;line-height: 18px;white-space: nowrap;vertical-align: middle;');
    return btn;
}

function getGalleryGroupsFromTbody(tbody) {
    var allTrs = tbody ? tbody.querySelectorAll('tr:not(.gtr)') : [];
    var groups = [];
    var currentGroup = [];

    Array.prototype.forEach.call(allTrs || [], function(tr) {
        currentGroup.push(tr);
        if (currentGroup.length === 2) {
            groups.push(currentGroup);
            currentGroup = [];
        }
    });

    return groups;
}

function getCheckedGalleryGroupsFromTbody(tbody) {
    return getGalleryGroupsFromTbody(tbody).filter(function(group) {
        var tr1 = group[0];
        var cb = tr1 ? tr1.querySelector('td.gtc6 input[type="checkbox"]') : null;
        return !!(cb && cb.checked);
    });
}

function getGalleryGroupFields(group) {
    var tr1 = group && group[0];
    var tr2 = group && group[1];
    if (!tr1 || !tr2) return null;

    var selects = tr1.querySelectorAll('td.gtc4 select');
    var checkboxes = tr2.querySelectorAll('td.gtc-options input[type="checkbox"]');

    return {
        group: group,
        tr1: tr1,
        tr2: tr2,
        titleInput: tr1.querySelector('td.gtc1 input'),
        jpTitleInput: tr2.querySelector('td.gtc1 input'),
        filesCell: tr1.querySelector('td.gtc3'),
        categorySelect: selects[0] || null,
        languageSelect: selects[1] || null,
        folderSelect: selects[2] || null,
        mtlCheckbox: checkboxes[0] || null,
        officialCheckbox: checkboxes[1] || null,
        aiGeneratedCheckbox: checkboxes[2] || null,
        anthologyCheckbox: checkboxes[3] || null,
        translatedCheckbox: checkboxes[4] || null,
        decensoredCheckbox: checkboxes[5] || null,
        incompleteCheckbox: checkboxes[6] || null,
        rewriteCheckbox: checkboxes[7] || null,
        colorizedCheckbox: checkboxes[8] || null,
        ongoingCheckbox: checkboxes[9] || null,
        digitalCheckbox: checkboxes[10] || null,
        sampleCheckbox: checkboxes[11] || null,
        mtlContainer: tr2.querySelector('td.gtc-options > span:first-child'),
        commentTextarea: tr2.querySelector('td.gtc-options textarea.uploader-comment-ta'),
        romanBtn: Array.from(tr2.querySelectorAll('button')).find(function(btn) {
            return btn.textContent === 'Romanization';
        }) || null
    };
}

function getGalleryGroupLanguageDefaultControls(tr2) {
    if (!tr2) return null;
    return {
        mtlCheckbox: tr2.querySelectorAll('td.gtc-options input[type="checkbox"]')[0] || null,
        officialCheckbox: tr2.querySelectorAll('td.gtc-options input[type="checkbox"]')[1] || null,
        aiGeneratedCheckbox: tr2.querySelectorAll('td.gtc-options input[type="checkbox"]')[2] || null,
        translatedCheckbox: tr2.querySelectorAll('td.gtc-options input[type="checkbox"]')[4] || null,
        rewriteCheckbox: tr2.querySelectorAll('td.gtc-options input[type="checkbox"]')[7] || null,
        mtlContainer: tr2.querySelector('td.gtc-options > span:first-child')
    };
}

function applyLanguageDefaultsByControls(languageValue, controls, settingsOverride) {
    if (!controls) return;

    var settings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe() || {}, settingsOverride || {});
    var langValue = String(languageValue == null ? '' : languageValue);
    var isJapanese = langValue === '0';

    if (!isJapanese && settings.nonJapaneseDefaultTranslated) {
        if (controls.translatedCheckbox) controls.translatedCheckbox.checked = true;
        if (controls.officialCheckbox) controls.officialCheckbox.checked = false;
        if (controls.rewriteCheckbox) controls.rewriteCheckbox.checked = false;
        if (controls.mtlContainer) controls.mtlContainer.style.display = 'inline-flex';
        if (controls.mtlCheckbox) controls.mtlCheckbox.checked = !!settings.translatedDefaultMTL;
    }

    if (isJapanese && settings.japaneseDefaultOfficialTextless) {
        if (controls.officialCheckbox) controls.officialCheckbox.checked = true;
        if (controls.translatedCheckbox) controls.translatedCheckbox.checked = false;
        if (controls.rewriteCheckbox) controls.rewriteCheckbox.checked = false;
        if (controls.mtlContainer) controls.mtlContainer.style.display = 'none';
        if (controls.mtlCheckbox) controls.mtlCheckbox.checked = false;
    }

    if (isJapanese && controls.aiGeneratedCheckbox) {
        controls.aiGeneratedCheckbox.checked = settings.japaneseDefaultAIGenerated !== false;
    }
}

function handleGalleryLanguageControlChange(languageSelect, settingsOverride) {
    if (!languageSelect) return;
    var tr1 = languageSelect.closest('tr');
    var tr2 = tr1 ? tr1.nextElementSibling : null;
    applyLanguageDefaultsByControls(languageSelect.value, getGalleryGroupLanguageDefaultControls(tr2), settingsOverride);
}

function setGalleryGroupSelectValue(selectEl, value) {
    if (!selectEl) return;
    selectEl.value = value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

function updateWaitingCreateCount(folderRow1, waitingCreateCountRef, delta) {
    if (!waitingCreateCountRef || typeof waitingCreateCountRef.value !== 'number') return;
    waitingCreateCountRef.value = Math.max(0, waitingCreateCountRef.value + delta);
    var folderStrong = folderRow1 ? folderRow1.querySelector('strong') : null;
    if (folderStrong) folderStrong.textContent = waitingCreateCountRef.value;
}

function getGalleryGroupSavedDataId(fields) {
    if (!fields || !fields.tr2) return null;
    var id = String(fields.tr2.dataset.savedDataId || '').trim();
    return id || null;
}

function buildGalleryDataFromFields(fields) {
    var existingId = getGalleryGroupSavedDataId(fields);
    return {
        id: existingId || (Date.now() + '_' + (fields.titleInput ? fields.titleInput.value : '')),
        title1: fields.titleInput ? fields.titleInput.value : '',
        title2: fields.jpTitleInput ? fields.jpTitleInput.value : '',
        files: fields.filesCell ? fields.filesCell.textContent : 'N/A',
        category: fields.categorySelect ? fields.categorySelect.value : 'Doujinshi',
        language: fields.languageSelect ? fields.languageSelect.value : '0',
        folder: fields.folderSelect ? fields.folderSelect.value : 'Unsorted',
        options: {
            official: fields.officialCheckbox ? fields.officialCheckbox.checked : false,
            translated: fields.translatedCheckbox ? fields.translatedCheckbox.checked : false,
            rewrite: fields.rewriteCheckbox ? fields.rewriteCheckbox.checked : false,
            digital: fields.digitalCheckbox ? fields.digitalCheckbox.checked : false,
            decensored: fields.decensoredCheckbox ? fields.decensoredCheckbox.checked : false,
            aiGenerated: fields.aiGeneratedCheckbox ? fields.aiGeneratedCheckbox.checked : false,
            colorized: fields.colorizedCheckbox ? fields.colorizedCheckbox.checked : false,
            textless: false,
            incomplete: fields.incompleteCheckbox ? fields.incompleteCheckbox.checked : false,
            sample: fields.sampleCheckbox ? fields.sampleCheckbox.checked : false,
            anthology: fields.anthologyCheckbox ? fields.anthologyCheckbox.checked : false,
            ongoing: fields.ongoingCheckbox ? fields.ongoingCheckbox.checked : false
        },
        mtl: fields.mtlCheckbox ? fields.mtlCheckbox.checked : false,
        comment: fields.commentTextarea ? fields.commentTextarea.value : '',
        timestamp: Date.now()
    };
}

function persistGalleryGroup(fields) {
    var galleryData = buildGalleryDataFromFields(fields);
    upsertSavedGallery(galleryData);
    if (fields && fields.tr2) fields.tr2.dataset.savedDataId = galleryData.id;
    return galleryData;
}

function buildPendingCreateDataFromFields(fields) {
    var categoryMap = {
        'Doujinshi': '2',
        'Manga': '3',
        'Artist CG': '4',
        'Game CG': '5',
        'Western': '10',
        'Non-H': '9',
        'Image Set': '6',
        'Cosplay': '7',
        'Misc': '1'
    };
    var langTypeVal = '0';

    if (fields.translatedCheckbox && fields.translatedCheckbox.checked) langTypeVal = '1';
    else if (fields.rewriteCheckbox && fields.rewriteCheckbox.checked) langTypeVal = '2';

    var mainVal = fields.titleInput ? fields.titleInput.value : '';
    var jpVal = fields.jpTitleInput ? fields.jpTitleInput.value : '';

    if (mainVal && !jpVal) jpVal = mainVal;
    else if (!mainVal && jpVal) mainVal = jpVal;

    return {
        id: Date.now() + '_' + mainVal,
        title1: mainVal,
        title2: jpVal,
        files: fields.filesCell ? fields.filesCell.textContent : 'N/A',
        category: categoryMap[fields.categorySelect ? fields.categorySelect.value : 'Doujinshi'] || '2',
        categoryText: fields.categorySelect ? fields.categorySelect.value : 'Doujinshi',
        language: fields.languageSelect ? fields.languageSelect.value : '0',
        folder: fields.folderSelect ? fields.folderSelect.value : 'Unsorted',
        langtype: langTypeVal,
        mtl: fields.mtlCheckbox ? fields.mtlCheckbox.checked : false,
        comment: fields.commentTextarea ? fields.commentTextarea.value : '',
        savedDataId: getGalleryGroupSavedDataId(fields),
        options: {
            official: fields.officialCheckbox ? fields.officialCheckbox.checked : false,
            translated: fields.translatedCheckbox ? fields.translatedCheckbox.checked : false,
            rewrite: fields.rewriteCheckbox ? fields.rewriteCheckbox.checked : false,
            digital: fields.digitalCheckbox ? fields.digitalCheckbox.checked : false,
            decensored: fields.decensoredCheckbox ? fields.decensoredCheckbox.checked : false,
            aiGenerated: fields.aiGeneratedCheckbox ? fields.aiGeneratedCheckbox.checked : false,
            colorized: fields.colorizedCheckbox ? fields.colorizedCheckbox.checked : false,
            textless: false,
            incomplete: fields.incompleteCheckbox ? fields.incompleteCheckbox.checked : false,
            sample: fields.sampleCheckbox ? fields.sampleCheckbox.checked : false,
            anthology: fields.anthologyCheckbox ? fields.anthologyCheckbox.checked : false,
            ongoing: fields.ongoingCheckbox ? fields.ongoingCheckbox.checked : false
        }
    };
}

function runGalleryGroupRomanization(fields) {
    if (!fields || !fields.titleInput || !fields.jpTitleInput || !fields.romanBtn) {
        return Promise.resolve(false);
    }

    var jpText = String(fields.jpTitleInput.value || '').trim();
    if (!jpText) return Promise.resolve(false);

    return Promise.resolve(convertToRomaji(jpText, fields.romanBtn, fields.titleInput)).then(function() {
        return true;
    }).catch(function(err) {
        errorLog('BulkRomanization', '批量轉換失敗', {
            message: err && (err.message || String(err)),
            title: jpText
        });
        return false;
    });
}

function applyGalleryOptionStateToFields(fields, optionState) {
    if (!fields) return;
    optionState = optionState || {};

    if (fields.officialCheckbox) fields.officialCheckbox.checked = !!optionState.official;
    if (fields.translatedCheckbox) fields.translatedCheckbox.checked = !!optionState.translated;
    if (fields.rewriteCheckbox) fields.rewriteCheckbox.checked = !!optionState.rewrite;
    if (fields.digitalCheckbox) fields.digitalCheckbox.checked = !!optionState.digital;
    if (fields.decensoredCheckbox) fields.decensoredCheckbox.checked = !!optionState.decensored;
    if (fields.aiGeneratedCheckbox) fields.aiGeneratedCheckbox.checked = !!optionState.aiGenerated;
    if (fields.colorizedCheckbox) fields.colorizedCheckbox.checked = !!optionState.colorized;
    if (fields.incompleteCheckbox) fields.incompleteCheckbox.checked = !!optionState.incomplete;
    if (fields.sampleCheckbox) fields.sampleCheckbox.checked = !!optionState.sample;
    if (fields.ongoingCheckbox) fields.ongoingCheckbox.checked = !!optionState.ongoing;
    if (fields.anthologyCheckbox) fields.anthologyCheckbox.checked = !!optionState.anthology;

    if (fields.mtlContainer) {
        fields.mtlContainer.style.display = optionState.translated ? 'inline-flex' : 'none';
    }

    if (fields.mtlCheckbox) {
        fields.mtlCheckbox.checked = !!(optionState.translated && optionState.mtl);
        if (!optionState.translated) fields.mtlCheckbox.checked = false;
    }
}

function deleteGalleryGroupByFields(fields, folderRow1, waitingCreateCountRef) {
    if (!fields || !fields.group || !fields.group.length) return false;

    var savedDataId = getGalleryGroupSavedDataId(fields);
    fields.group.forEach(function(tr) {
        if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
    });

    updateWaitingCreateCount(folderRow1, waitingCreateCountRef, -1);

    if (savedDataId) {
        try {
            removeSavedGalleryById(savedDataId);
            deleteGalleryFileListById(savedDataId);
        } catch (err) {
            errorLog('DeleteGallery', '刪除保存資料失敗', err);
        }
    }

    return true;
}

function resetDeleteTriggerState(btn) {
    if (!btn) return;
    if (btn.__fifybujDeleteTriggerTimer) {
        clearTimeout(btn.__fifybujDeleteTriggerTimer);
        btn.__fifybujDeleteTriggerTimer = null;
    }
    if (btn.__fifybujDeleteTriggerController && typeof btn.__fifybujDeleteTriggerController.restore === 'function') {
        btn.__fifybujDeleteTriggerController.restore();
    }
    btn.__fifybujDeleteTriggerController = null;
    btn.__fifybujDeleteTriggerPending = false;
    btn.__fifybujDeleteTriggerExpireAt = 0;
}

function triggerDeleteBySettings(btn, onConfirmed) {
    var settings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe() || {});

    if (!settings.deleteDoubleConfirm) {
        resetDeleteTriggerState(btn);
        onConfirmed();
        return true;
    }

    var isPending = !!btn.__fifybujDeleteTriggerPending && Date.now() <= (btn.__fifybujDeleteTriggerExpireAt || 0);

    if (!isPending) {
        resetDeleteTriggerState(btn);
        btn.__fifybujDeleteTriggerPending = true;
        btn.__fifybujDeleteTriggerExpireAt = Date.now() + (settings.doubleConfirmMs || 1000);
        btn.__fifybujDeleteTriggerController = _beginFeedbackState(btn, {
            restoreText: _getFeedbackElementText(btn),
            useColor: true,
            colorType: 'error'
        });
        btn.__fifybujDeleteTriggerTimer = setTimeout(function() {
            resetDeleteTriggerState(btn);
        }, settings.doubleConfirmMs || 1000);
        return false;
    }

    resetDeleteTriggerState(btn);
    onConfirmed();
    return true;
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
    var savedCount = 0;

    getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
        var fields = getGalleryGroupFields(group);
        if (!fields) return;

        try {
            persistGalleryGroup(fields);
            savedCount++;
        } catch (err) {
            errorLog('BulkSave', '批量保存失敗', err);
        }
    });

    if (savedCount > 0) {
        opLog('批量 Save', { count: savedCount });
        refreshShowFileListPanelIfOpen();
    }

    return savedCount;
}

// ==================== 頂層函數：allCreateChecked ====================

function allCreateChecked(tbody) {
    var pendingQueue = [];

    getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
        var fields = getGalleryGroupFields(group);
        if (!fields) return;
        pendingQueue.push(buildPendingCreateDataFromFields(fields));
    });

    if (pendingQueue.length > 0) {
        GM_setValue('pending_create_queue', pendingQueue);
        opLog('批量 Create', { count: pendingQueue.length });
        pendingQueue.forEach(function() {
            GM_openInTab('https://upload.e-hentai.org/managegallery?act=new', { active: false });
        });
    }

    return pendingQueue.length;
}

function allRomanizationChecked(tbody) {
    var groups = getCheckedGalleryGroupsFromTbody(tbody);
    var count = 0;

    return groups.reduce(function(chain, group) {
        return chain.then(function() {
            var fields = getGalleryGroupFields(group);
            if (!fields) return false;

            return runGalleryGroupRomanization(fields).then(function(ok) {
                if (ok) count++;
                return ok;
            });
        });
    }, Promise.resolve()).then(function() {
        if (count > 0) opLog('批量 Romanization', { count: count });
        return count;
    });
}

// ==================== 頂層函數：allDeleteChecked ====================

function allDeleteChecked(tbody, folderRow1, waitingCreateCountRef) {
    var deletedCount = 0;

    getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
        var fields = getGalleryGroupFields(group);
        if (!fields) return;
        if (deleteGalleryGroupByFields(fields, folderRow1, waitingCreateCountRef)) deletedCount++;
    });

    if (deletedCount > 0) {
        refreshShowFileListPanelIfOpen();
        opLog('批量 Delete', { count: deletedCount });
    }

    return deletedCount;
}

// ==================== 頂層函數：fixAllGroups ====================

function fixAllGroups(sectionDiv, folderRow1) {
    var firstRow = sectionDiv.querySelector('tbody tr:not(.gtr)');
    if (!firstRow) return;
    sectionDiv.querySelectorAll('td.gtc3').forEach(function(td) {
        var btns = Array.from(td.querySelectorAll('button'));
        if (btns.length > 0) alignSwapBtn(btns, td);
    });
    sectionDiv.querySelectorAll('td.gtc3 span.files-text').forEach(function(span) {
        var td = span.closest('td');
        if (td) alignFilesText(span, td);
    });
}

// ==================== Romanization 規則引擎 ====================

var HONORIFICS = ['chan', 'kun', 'san', 'sama', 'dono', 'senpai', 'kouhai', 'sensei'];

var JMDICT_ZIP_URL = 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english.zip';
var KANJIDIC_ZIP_URL = 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.zip';

var DISABLE_RUNTIME_JMDICT_ZIP_PARSE = false;
var DISABLE_RUNTIME_KANJIDIC_ZIP_PARSE = false;
var PREBUILT_JMDICT_BUNDLE_URL = '';
var PREBUILT_KANJIDIC_BUNDLE_URL = '';
var JMDICT_INDEX_KEYS = [
    'jmdict_data',
    'jmdict_download_time',
    'jmdict_expression_index',
    'jmdict_reading_index',
    'jmdict_kana_normalized_index',
    'jmdict_mixed_script_index',
    'jmdict_katakana_english_index'
];
var KANJIDIC_INDEX_KEYS = [
    'kanjidic_data',
    'kanjidic_download_time',
    'kanji_char_reading_index',
    'kanji_variant_map'
];
var JAPANESE_VARIANT_CHAR_MAP = {
    '壱': '一', '壹': '一',
    '弐': '二', '貳': '二', '贰': '二',
    '参': '三', '參': '三', '叁': '三',
    '萬': '万', '拾': '十',
    '饭': '飯', '靜': '静', '國': '国', '圓': '円',
    '學': '学', '體': '体', '變': '変', '鹽': '塩',
    '處': '処', '畫': '画', '會': '会', '舊': '旧',
    '龍': '竜', '濱': '浜', '邊': '辺', '佛': '仏',
    '醫': '医', '兒': '児', '勞': '労', '廣': '広',
    '澤': '沢', '瀨': '瀬', '德': '徳', '圍': '囲',
    '驛': '駅', '龜': '亀', '嶽': '岳', '冩': '写'
};
function dictDebug(stage, payload) {
    try { _debug('[DictDebug]', stage, payload); } catch (e) {}
    return;
    try { _debug('[DictDebug]', stage, payload); } catch (e) {}
}

var NUMERIC_KANJI_MAP = {
    '零': 0, '〇': 0,
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
    '十': 10, '百': 100, '千': 1000, '万': 10000
};

function normalizeJapaneseVariants(text) {
    text = String(text || '');
    try { text = text.normalize('NFKC'); } catch (e) {}
    return text.replace(/[壱壹弐貳贰参參叁萬拾饭靜國圓學體變鹽處畫會舊龍濱邊佛醫兒勞廣澤瀨德圍驛龜嶽冩]/g, function(ch) {
        return JAPANESE_VARIANT_CHAR_MAP[ch] || ch;
    });
}

function katakanaToHiragana(text) {
    return String(text || '').replace(/[ァ-ヶ]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
}

function hiraganaToKatakana(text) {
    return String(text || '').replace(/[ぁ-ゖ]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
}

function normalizeKana(text) {
    return katakanaToHiragana(normalizeJapaneseVariants(text));
}

function normalizeMixedScriptKey(text) {
    return normalizeKana(normalizeJapaneseVariants(String(text || '').replace(/[\s　]+/g, ''))).toLowerCase();
}

function isPureKatakana(text) {
    return /^[ァ-ヶー]+$/.test(String(text || ''));
}

function containsKanji(text) {
    return /[一-龯々〆ヵヶ]/.test(String(text || ''));
}

function isAsciiWord(text) {
    return /^[A-Za-z0-9][A-Za-z0-9'._\-]*$/.test(String(text || ''));
}

function isAllCapsWesternAbbr(text) {
    return /^[A-Z0-9][A-Z0-9&+._-]*$/.test(String(text || '')) && String(text || '') === String(text || '').toUpperCase();
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function uniquePush(arr, item) {
    if (arr.indexOf(item) === -1) arr.push(item);
}

function extractStructuredStrings(node, bucket) {
    if (node == null) return;
    if (typeof node === 'string') {
        var clean = node.replace(/\s+/g, ' ').trim();
        if (clean) bucket.push(clean);
        return;
    }
    if (Array.isArray(node)) {
        node.forEach(function(part) { extractStructuredStrings(part, bucket); });
        return;
    }
    if (typeof node === 'object') {
        if (typeof node.text === 'string') extractStructuredStrings(node.text, bucket);
        if (node.content != null) extractStructuredStrings(node.content, bucket);
        if (node.children != null) extractStructuredStrings(node.children, bucket);
        if (node.data != null) extractStructuredStrings(node.data, bucket);
    }
}

function flattenGlossaryArray(raw) {
    var bucket = [];
    toArray(raw).forEach(function(item) {
        extractStructuredStrings(item, bucket);
    });
    return bucket.map(function(s) {
        return String(s || '').replace(/[【】［］（）()]/g, ' ').replace(/\s+/g, ' ').trim();
    }).filter(function(s) { return !!s; });
}

function extractBestEnglishGloss(entry) {
    if (!entry) return null;
    var candidates = flattenGlossaryArray(entry.glossary || []);
    var english = candidates.filter(function(s) {
        return /^[A-Za-z][A-Za-z0-9 '&+./\-]*$/.test(s);
    });
    if (!english.length) return null;
    english.sort(function(a, b) {
        var aWords = a.split(/\s+/).length;
        var bWords = b.split(/\s+/).length;
        if (aWords !== bWords) return aWords - bWords;
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
    });
    return english[0];
}

function addIndexEntry(index, key, entry) {
    key = String(key || '').trim();
    if (!key) return;
    if (!index[key]) index[key] = [];
    var sig = (entry.expression || '') + '|' + (entry.reading || '') + '|' + String(entry.sequence || '');
    var exists = index[key].some(function(item) {
        return ((item.expression || '') + '|' + (item.reading || '') + '|' + String(item.sequence || '')) === sig;
    });
    if (!exists) index[key].push(entry);
}

function buildJMdictIndexes(entries) {
    dictDebug('buildJMdictIndexes:start', {
        entryCount: Array.isArray(entries) ? entries.length : 0
    });
    var expressionIndex = {};
    var readingIndex = {};
    var kanaNormalizedIndex = {};
    var mixedScriptIndex = {};
    var katakanaEnglishIndex = {};

    entries.forEach(function(entry, entryIndex) {
        if (entryIndex > 0 && entryIndex % 10000 === 0) {
            dictDebug('buildJMdictIndexes:progress', {
                entryIndex: entryIndex,
                expressionKeys: Object.keys(expressionIndex).length,
                readingKeys: Object.keys(readingIndex).length,
                kanaNormalizedKeys: Object.keys(kanaNormalizedIndex).length,
                mixedScriptKeys: Object.keys(mixedScriptIndex).length,
                katakanaEnglishKeys: Object.keys(katakanaEnglishIndex).length
            });
        }
        entry.bestEnglish = entry.bestEnglish || extractBestEnglishGloss(entry);

        addIndexEntry(expressionIndex, entry.expression, entry);
        addIndexEntry(mixedScriptIndex, normalizeMixedScriptKey(entry.expression), entry);

        if (entry.reading) {
            addIndexEntry(readingIndex, entry.reading, entry);
            addIndexEntry(readingIndex, normalizeKana(entry.reading), entry);
            addIndexEntry(kanaNormalizedIndex, normalizeKana(entry.reading), entry);
            addIndexEntry(mixedScriptIndex, normalizeMixedScriptKey(entry.reading), entry);
        }

        addIndexEntry(kanaNormalizedIndex, normalizeKana(entry.expression), entry);

        if (entry.bestEnglish) {
            if (isPureKatakana(entry.expression)) addIndexEntry(katakanaEnglishIndex, entry.expression, entry);
            if (entry.reading && isPureKatakana(entry.reading)) addIndexEntry(katakanaEnglishIndex, entry.reading, entry);
        }
    });

    dictDebug('buildJMdictIndexes:done', {
        expressionKeys: Object.keys(expressionIndex).length,
        readingKeys: Object.keys(readingIndex).length,
        kanaNormalizedKeys: Object.keys(kanaNormalizedIndex).length,
        mixedScriptKeys: Object.keys(mixedScriptIndex).length,
        katakanaEnglishKeys: Object.keys(katakanaEnglishIndex).length
    });
    return {
        expressionIndex: expressionIndex,
        readingIndex: readingIndex,
        kanaNormalizedIndex: kanaNormalizedIndex,
        mixedScriptIndex: mixedScriptIndex,
        katakanaEnglishIndex: katakanaEnglishIndex
    };
}

function buildKANJIDICIndexes(entries) {
    var kanjiCharReadingIndex = {};
    var variantMap = {};
    Object.keys(JAPANESE_VARIANT_CHAR_MAP).forEach(function(key) {
        variantMap[key] = JAPANESE_VARIANT_CHAR_MAP[key];
    });

    entries.forEach(function(entry) {
        if (!entry || !entry.kanji) return;
        var reading = '';
        if (entry.onyomi) reading = String(entry.onyomi).split(/\s+/)[0] || '';
        if (!reading && entry.kunyomi) {
            reading = String(entry.kunyomi).split(/\s+/)[0] || '';
            reading = reading.replace(/\..*$/, '');
        }
        if (reading) kanjiCharReadingIndex[entry.kanji] = reading;
        variantMap[entry.kanji] = entry.kanji;
    });

    return {
        kanjiCharReadingIndex: kanjiCharReadingIndex,
        variantMap: variantMap
    };
}

var ZIP_ENTRY_DECODE_TIMEOUT_MS = 20000;

function promiseWithTimeout(promise, ms, label) {
    return new Promise(function(resolve, reject) {
        var done = false;
        var timer = setTimeout(function() {
            if (done) return;
            done = true;
            reject(new Error(label + ' timeout after ' + ms + 'ms'));
        }, ms);

        Promise.resolve(promise).then(function(value) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        }).catch(function(err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}

function toUint8ArrayLoose(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.length || 0);
    }
    if (Array.isArray(value)) return new Uint8Array(value);
    if (typeof value === 'string') {
        var out = new Uint8Array(value.length);
        for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
        return out;
    }
    if (typeof value.length === 'number') {
        try { return Uint8Array.from(value); } catch (e) {}
    }
    return null;
}

function inflateRawBytesNative(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('DecompressionStream unavailable'));
    }
    bytes = toUint8ArrayLoose(bytes);
    if (!bytes) {
        return Promise.reject(new Error('invalid compressed bytes'));
    }

    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function(buffer) {
        return new Uint8Array(buffer);
    });
}

function getZipEntryBytesFast(entry) {
    var data = entry && entry._data;
    var compressionMagic = data && data.compression && data.compression.magic;
    var compressedBytes = toUint8ArrayLoose(data && data.compressedContent);
    var compressedByteLength = compressedBytes ? (typeof compressedBytes.byteLength === 'number' ? compressedBytes.byteLength : compressedBytes.length || 0) : 0;
    var magicCode = compressionMagic && compressionMagic.length ? compressionMagic.charCodeAt(0) : null;
    var isStored = compressionMagic === '\x00\x00';
    var isDeflate = magicCode === 8;

    dictDebug('getZipEntryBytesFast:begin', {
        name: entry && entry.name,
        hasInternalCompressedContent: !!compressedBytes,
        compressedByteLength: compressedByteLength,
        compressionMagicCode: magicCode,
        hasNativeDecompressionStream: typeof DecompressionStream !== 'undefined'
    });

    if (compressedBytes && isStored) {
        dictDebug('getZipEntryBytesFast:stored', {
            name: entry && entry.name,
            byteLength: compressedByteLength
        });
        return Promise.resolve({
            bytes: compressedBytes,
            source: 'stored'
        });
    }

    if (compressedBytes && isDeflate && typeof DecompressionStream !== 'undefined') {
        dictDebug('getZipEntryBytesFast:native_inflate:begin', {
            name: entry && entry.name,
            compressedByteLength: compressedByteLength
        });

        return promiseWithTimeout(
            inflateRawBytesNative(compressedBytes),
            ZIP_ENTRY_DECODE_TIMEOUT_MS,
            'native inflate ' + (entry && entry.name)
        ).then(function(bytes) {
            bytes = toUint8ArrayLoose(bytes) || bytes;
            dictDebug('getZipEntryBytesFast:native_inflate:done', {
                name: entry && entry.name,
                byteLength: bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : (bytes && bytes.length) || 0
            });
            return {
                bytes: bytes,
                source: 'native-deflate'
            };
        }).catch(function(err) {
            dictDebug('getZipEntryBytesFast:native_inflate:fallback', {
                name: entry && entry.name,
                error: err && (err.message || String(err))
            });

            return promiseWithTimeout(
                entry.async('uint8array'),
                ZIP_ENTRY_DECODE_TIMEOUT_MS,
                'jszip inflate ' + (entry && entry.name)
            ).then(function(bytes) {
                bytes = toUint8ArrayLoose(bytes) || bytes;
                dictDebug('getZipEntryBytesFast:jszip_fallback:done', {
                    name: entry && entry.name,
                    byteLength: bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : (bytes && bytes.length) || 0
                });
                return {
                    bytes: bytes,
                    source: 'jszip-fallback'
                };
            });
        });
    }

    dictDebug('getZipEntryBytesFast:jszip_only', {
        name: entry && entry.name,
        reason: !compressedBytes ? 'missing_internal_compressed_content' : (!isDeflate ? 'unsupported_compression' : 'native_unavailable')
    });

    return promiseWithTimeout(
        entry.async('uint8array'),
        ZIP_ENTRY_DECODE_TIMEOUT_MS,
        'jszip inflate ' + (entry && entry.name)
    ).then(function(bytes) {
        bytes = toUint8ArrayLoose(bytes) || bytes;
        dictDebug('getZipEntryBytesFast:jszip_only:done', {
            name: entry && entry.name,
            byteLength: bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : (bytes && bytes.length) || 0
        });
        return {
            bytes: bytes,
            source: 'jszip'
        };
    });
}

function decodeZipEntryText(entry) {
    var startedAt = Date.now();
    dictDebug('decodeZipEntryText:begin', entry && entry.name);

    return getZipEntryBytesFast(entry).then(function(result) {
        var bytes = result && result.bytes ? result.bytes : result;
        var source = result && result.source ? result.source : 'unknown';
        bytes = toUint8ArrayLoose(bytes) || bytes;
        var byteLength = 0;
        if (bytes) {
            byteLength = typeof bytes.byteLength === 'number' ? bytes.byteLength : (typeof bytes.length === 'number' ? bytes.length : 0);
        }

        dictDebug('decodeZipEntryText:bytes_loaded', {
            name: entry && entry.name,
            byteLength: byteLength,
            source: source,
            costMs: Date.now() - startedAt
        });

        var text = '';
        if (typeof TextDecoder !== 'undefined') {
            text = new TextDecoder('utf-8').decode(bytes);
        } else {
            var binary = '';
            for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            text = decodeURIComponent(escape(binary));
        }

        dictDebug('decodeZipEntryText:decode_done', {
            name: entry && entry.name,
            textLength: text ? text.length : 0,
            costMs: Date.now() - startedAt
        });

        return {
            name: entry && entry.name,
            bytes: bytes,
            text: text,
            byteLength: byteLength,
            source: source,
            costMs: Date.now() - startedAt
        };
    }).catch(function(err) {
        dictDebug('decodeZipEntryText:error', {
            name: entry && entry.name,
            error: err && (err.stack || err.message || String(err))
        });
        throw err;
    });
}

function parseJMdictArchive(buffer) {
    return JSZip.loadAsync(buffer).then(function(zip) {
        dictDebug('parseJMdictArchive:start', {
        size: buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : null
    });
        var files = [];
        zip.forEach(function(path, entry) {
            if (!entry.dir && /(^|\/)term_bank_\d+\.json$/.test(path)) files.push(entry);
        });
        files.sort(function(a, b) { return a.name.localeCompare(b.name); });

        dictDebug('parseJMdictArchive:zip:files', {
        count: files.length,
        names: files.map(function(entry) { return entry.name; }).slice(0, 10)
    });
        var allEntries = [];
        return files.reduce(function(chain, entry) {
            return chain.then(function() {
                dictDebug('parseJMdictArchive:file:start', entry.name);
                return decodeZipEntryText(entry).then(function(decoded) {
                    var text = decoded.text;
                    dictDebug('parseJMdictArchive:file:text_loaded', {
                        name: entry.name,
                        textLength: text ? text.length : 0,
                        byteLength: decoded && typeof decoded.byteLength === 'number' ? decoded.byteLength : null,
                        source: decoded && decoded.source ? decoded.source : null,
                        decodeCostMs: decoded && typeof decoded.costMs === 'number' ? decoded.costMs : null
                    });
                    var data = [];
                    dictDebug('parseJMdictArchive:file:json_parse:begin', { name: entry.name });
                    try {
                        data = JSON.parse(text);
                        dictDebug('parseJMdictArchive:file:json_parse:done', {
                            name: entry.name,
                            itemCount: Array.isArray(data) ? data.length : 0
                        });
                    } catch (e) {
                        dictDebug('parseJMdictArchive:file:json_parse:error', {
                            name: entry.name,
                            error: e && (e.stack || e.message || String(e))
                        });
                        data = [];
                    }
                    dictDebug('parseJMdictArchive:file:item_loop:begin', {
                        name: entry.name,
                        itemCount: Array.isArray(data) ? data.length : 0
                    });
                    toArray(data).forEach(function(item, itemIndex) {
                        if (itemIndex > 0 && itemIndex % 5000 === 0) {
                            dictDebug('parseJMdictArchive:file:item_loop:progress', {
                                name: entry.name,
                                itemIndex: itemIndex,
                                currentAllEntries: allEntries.length
                            });
                        }
                        if (!Array.isArray(item) || item.length < 8) return;
                        var parsed = {
                            expression: item[0] || '',
                            reading: item[1] || '',
                            definitionTags: item[2] || '',
                            rules: item[3] || '',
                            score: item[4] || 0,
                            glossary: flattenGlossaryArray(item[5] || []),
                            sequence: item[6] || 0,
                            termTags: item[7] || ''
                        };
                        if (!parsed.expression) return;
                        parsed.bestEnglish = extractBestEnglishGloss(parsed);
                        allEntries.push(parsed);
                    });
                    dictDebug('parseJMdictArchive:file:item_loop:done', {
                        name: entry.name,
                        accumulatedEntries: allEntries.length
                    });
                });
            });
        }, Promise.resolve()).then(function() {
            dictDebug('parseJMdictArchive:done', { entries: allEntries.length });
            return allEntries;
        });
    });
}

function parseKANJIDICArchive(buffer) {
    return JSZip.loadAsync(buffer).then(function(zip) {
        dictDebug('parseKANJIDICArchive:start', {
        size: buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : null
    });
        var files = [];
        zip.forEach(function(path, entry) {
            if (!entry.dir && /(^|\/)kanji_bank_\d+\.json$/.test(path)) files.push(entry);
        });
        files.sort(function(a, b) { return a.name.localeCompare(b.name); });

        dictDebug('parseKANJIDICArchive:zip:files', {
        count: files.length,
        names: files.map(function(entry) { return entry.name; }).slice(0, 10)
    });
        var allEntries = [];
        return files.reduce(function(chain, entry) {
            return chain.then(function() {
                dictDebug('parseKANJIDICArchive:file:start', entry.name);
                return decodeZipEntryText(entry).then(function(decoded) {
                    var text = decoded.text;
                    dictDebug('parseKANJIDICArchive:file:text_loaded', {
                        name: entry.name,
                        textLength: text ? text.length : 0,
                        byteLength: decoded && typeof decoded.byteLength === 'number' ? decoded.byteLength : null,
                        source: decoded && decoded.source ? decoded.source : null,
                        decodeCostMs: decoded && typeof decoded.costMs === 'number' ? decoded.costMs : null
                    });
                    var data = [];
                    try { data = JSON.parse(text); } catch (e) { data = []; }
                    toArray(data).forEach(function(item) {
                        if (!Array.isArray(item) || item.length < 6) return;
                        allEntries.push({
                            kanji: item[0] || '',
                            onyomi: item[1] || '',
                            kunyomi: item[2] || '',
                            tags: item[3] || '',
                            meanings: toArray(item[4]),
                            stats: item[5] || {}
                        });
                    });
                });
            });
        }, Promise.resolve()).then(function() {
            dictDebug('parseKANJIDICArchive:done', { entries: allEntries.length });
            return allEntries;
        });
    });
}

function getEntryCandidatesFromIndexes(text, indexes) {
    var result = [];
    if (!indexes) return result;
    [
        { map: indexes.expressionIndex, key: text },
        { map: indexes.readingIndex, key: text },
        { map: indexes.readingIndex, key: normalizeKana(text) },
        { map: indexes.kanaNormalizedIndex, key: normalizeKana(text) },
        { map: indexes.mixedScriptIndex, key: normalizeMixedScriptKey(text) }
    ].forEach(function(pair) {
        toArray((pair.map || {})[pair.key]).forEach(function(entry) {
            if (result.indexOf(entry) === -1) result.push(entry);
        });
    });
    return result;
}

function isProperNameEntry(entry) {
    var tags = ((entry && entry.definitionTags) || '') + ' ' + ((entry && entry.termTags) || '');
    return /(surname|person|place|given|name)/i.test(tags);
}

function selectBestEntry(entries, options) {
    options = options || {};
    var list = toArray(entries).slice();
    if (!list.length) return null;
    if (options.preferProperName) {
        var proper = list.filter(isProperNameEntry);
        if (proper.length) list = proper;
    }
    list.sort(function(a, b) {
        var aExpLen = (a.expression || '').length;
        var bExpLen = (b.expression || '').length;
        if (aExpLen !== bExpLen) return bExpLen - aExpLen;
        var aScore = typeof a.score === 'number' ? a.score : 0;
        var bScore = typeof b.score === 'number' ? b.score : 0;
        if (aScore !== bScore) return bScore - aScore;
        return (a.expression || '').localeCompare(b.expression || '');
    });
    return list[0];
}

function findBestDictionaryEntry(text, reading, indexes, options) {
    var candidates = getEntryCandidatesFromIndexes(text, indexes);
    if (reading && reading !== text) {
        getEntryCandidatesFromIndexes(reading, indexes).forEach(function(entry) {
            if (candidates.indexOf(entry) === -1) candidates.push(entry);
        });
    }
    return selectBestEntry(candidates, options);
}

function normalizeNumericKanjiText(text) {
    return normalizeJapaneseVariants(String(text || '')).replace(/[零〇一二三四五六七八九十百千万]/g, function(ch) {
        return ch;
    });
}

function isPureNumericKanji(text) {
    text = normalizeNumericKanjiText(text);
    return !!text && /^[零〇一二三四五六七八九十百千万]+$/.test(text);
}

function kanjiNumberToInt(text) {
    text = normalizeNumericKanjiText(text).replace(/[零〇]/g, '零');
    if (!text) return NaN;
    if (/^[一二三四五六七八九]+$/.test(text)) {
        return text.split('').reduce(function(acc, ch) {
            return acc * 10 + NUMERIC_KANJI_MAP[ch];
        }, 0);
    }

    function sectionToInt(section) {
        var total = 0;
        var num = 0;
        section.split('').forEach(function(ch) {
            if (ch === '千' || ch === '百' || ch === '十') {
                var unit = NUMERIC_KANJI_MAP[ch];
                total += (num || 1) * unit;
                num = 0;
            } else if (NUMERIC_KANJI_MAP.hasOwnProperty(ch)) {
                num = NUMERIC_KANJI_MAP[ch];
            }
        });
        return total + num;
    }

    var parts = text.split('万');
    if (parts.length === 1) return sectionToInt(parts[0]);
    var left = parts[0] ? sectionToInt(parts[0]) : 1;
    var right = parts[1] ? sectionToInt(parts[1]) : 0;
    return left * 10000 + right;
}

function intToJapaneseReadingRomaji(num) {
    num = Number(num);
    if (!isFinite(num) || num < 0) return '';
    if (num === 0) return 'rei';

    function under10000(n) {
        var out = '';
        var thousands = Math.floor(n / 1000);
        var hundreds = Math.floor((n % 1000) / 100);
        var tens = Math.floor((n % 100) / 10);
        var ones = n % 10;

        if (thousands) {
            if (thousands === 1) out += 'sen';
            else if (thousands === 3) out += 'sanzen';
            else if (thousands === 8) out += 'hassen';
            else out += ['','issen','nisen','sanzen','yonsen','gosen','rokusen','nanasen','hassen','kyuusen'][thousands];
        }
        if (hundreds) {
            if (hundreds === 1) out += 'hyaku';
            else if (hundreds === 3) out += 'sanbyaku';
            else if (hundreds === 6) out += 'roppyaku';
            else if (hundreds === 8) out += 'happyaku';
            else out += ['','ihyaku','nihyaku','sanbyaku','yonhyaku','gohyaku','roppyaku','nanahyaku','happyaku','kyuuhyaku'][hundreds];
        }
        if (tens) {
            if (tens === 1) out += 'juu';
            else out += ['','ijuu','nijuu','sanjuu','yonjuu','gojuu','rokujuu','nanajuu','hachijuu','kyuujuu'][tens];
        }
        if (ones) {
            out += ['','ichi','ni','san','yon','go','roku','nana','hachi','kyuu'][ones];
        }
        return out;
    }

    if (num >= 10000) {
        var man = Math.floor(num / 10000);
        var rest = num % 10000;
        return under10000(man) + 'man' + (rest ? under10000(rest) : '');
    }
    return under10000(num);
}

function convertNumericKanjiToReading(text) {
    var value = kanjiNumberToInt(text);
    if (!isFinite(value)) return '';
    return intToJapaneseReadingRomaji(value);
}

function matchesMaskedPattern(masked, candidate) {
    if (!masked || !candidate || masked.length !== candidate.length) return false;
    for (var i = 0; i < masked.length; i++) {
        if (masked.charAt(i) === '○') continue;
        if (masked.charAt(i) !== candidate.charAt(i)) return false;
    }
    return true;
}

function resolveMaskedToken(masked, jmdictData) {
    if (!masked || masked.indexOf('○') === -1) return masked;
    var exact = [];
    var fuzzy = [];
    toArray(jmdictData).forEach(function(entry) {
        [entry.expression, entry.reading, normalizeKana(entry.reading), normalizeMixedScriptKey(entry.expression), normalizeMixedScriptKey(entry.reading)].forEach(function(candidate) {
            candidate = String(candidate || '');
            if (!candidate) return;
            if (candidate === masked) uniquePush(exact, candidate);
            if (matchesMaskedPattern(masked, candidate)) uniquePush(fuzzy, candidate);
        });
    });
    if (exact.length === 1) return exact[0];
    if (fuzzy.length === 1) return fuzzy[0];
    return masked;
}

function replaceMaskedTokensInText(text, jmdictData) {
    return String(text || '').replace(/[A-Za-z0-9ァ-ヶーぁ-ん一-龯々〆ヵヶ○]+/g, function(token) {
        return token.indexOf('○') >= 0 ? resolveMaskedToken(token, jmdictData) : token;
    });
}

function splitKatakanaLoanwordGreedy(text, indexes) {
    text = String(text || '');
    if (!text || !indexes || !indexes.katakanaEnglishIndex) return null;
    var direct = selectBestEntry(indexes.katakanaEnglishIndex[text], {});
    if (direct && direct.bestEnglish) return direct.bestEnglish;

    for (var end = text.length - 1; end >= 1; end--) {
        var left = text.slice(0, end);
        var right = text.slice(end);
        var leftEntry = selectBestEntry(indexes.katakanaEnglishIndex[left], {});
        if (!leftEntry || !leftEntry.bestEnglish) continue;
        var rightEnglish = splitKatakanaLoanwordGreedy(right, indexes);
        if (rightEnglish) return leftEntry.bestEnglish + ' ' + rightEnglish;
    }
    return null;
}

function romanizeByDictionaryOrFallback(text, reading, indexes, options) {
    options = options || {};
    text = String(text || '');
    reading = String(reading || '');

    var best = findBestDictionaryEntry(text, reading, indexes, { preferProperName: !!options.preferProperName });

    if (best) {
        if (options.preferProperName && isProperNameEntry(best)) {
            if (best.bestEnglish) return best.bestEnglish;
            if (best.reading) return kanaToRomajiCore(best.reading);
        }
        if (isPureKatakana(text) || isPureKatakana(best.expression || '') || isPureKatakana(best.reading || '')) {
            if (options.preferProperName && best.bestEnglish) {
                traceRomanization('romanizeByDictionaryOrFallback:katakana_proper_name', {
                    text: text,
                    reading: reading,
                    expression: best.expression || '',
                    bestEnglish: best.bestEnglish
                });
                return best.bestEnglish;
            }
            traceRomanization('romanizeByDictionaryOrFallback:katakana_romaji_only', {
                text: text,
                reading: reading,
                expression: best.expression || '',
                dictionaryReading: best.reading || ''
            });
            return kanaToRomajiCore(best.reading || text || best.expression || '');
        }
        if (best.reading) return kanaToRomajiCore(best.reading);
    }

    if (isPureNumericKanji(text) && !options.preferProperName) {
        var numeric = convertNumericKanjiToReading(text);
        if (numeric) return numeric;
    }

    var out = '';
    var i = 0;
    while (i < text.length) {
        var matched = null;
        for (var len = Math.min(8, text.length - i); len >= 2; len--) {
            var piece = text.slice(i, i + len);
            var entry = findBestDictionaryEntry(piece, '', indexes, {});
            if (!entry) continue;
            matched = {
                len: len,
                value: ((isPureKatakana(piece) || isPureKatakana(entry.expression || '') || isPureKatakana(entry.reading || '')) && entry.bestEnglish)
                    ? entry.bestEnglish
                    : (entry.reading ? kanaToRomajiCore(entry.reading) : '')
            };
            if (matched.value) break;
        }

        if (matched && matched.value) {
            out += matched.value;
            i += matched.len;
            continue;
        }

        var ch = text.charAt(i);
        if (containsKanji(ch)) {
            var charReading = indexes && indexes.kanjiCharReadingIndex ? indexes.kanjiCharReadingIndex[ch] : '';
            out += charReading ? kanaToRomajiCore(charReading) : '';
        } else if (/[ぁ-んァ-ヶー]/.test(ch)) {
            out += kanaToRomajiCore(ch);
        } else {
            out += ch;
        }
        i++;
    }
    return out;
}

function normalizeOutputSpacing(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\[\s+/g, '[')
        .replace(/\s+\]/g, ']')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([([{'"])\s+/g, '$1')
        .trim();
}

function canAutoInstallExternalDicts() {
    return !!(
        PREBUILT_JMDICT_BUNDLE_URL ||
        PREBUILT_KANJIDIC_BUNDLE_URL ||
        !DISABLE_RUNTIME_JMDICT_ZIP_PARSE ||
        !DISABLE_RUNTIME_KANJIDIC_ZIP_PARSE
    );
}

function shouldSkipRuntimeExternalZipAutoInstall() {
    return !canAutoInstallExternalDicts();
}

function hasAllExternalDictsDownloadedRewritten() {
    if (shouldSkipRuntimeExternalZipAutoInstall()) {
        dictDebug('hasAllExternalDictsDownloadedRewritten:auto_install_unavailable', {
            reason: 'runtime_zip_disabled_and_no_prebuilt_bundle_url'
        });
    }

    return checkAllDictsInIDB().then(function(allCached) {
        if (!allCached) return false;
        return Promise.all([
            dbGet('dicts', 'jmdict_data'),
            dbGet('dicts', 'jmdict_expression_index'),
            dbGet('dicts', 'jmdict_reading_index'),
            dbGet('dicts', 'jmdict_kana_normalized_index'),
            dbGet('dicts', 'jmdict_mixed_script_index'),
            dbGet('dicts', 'jmdict_katakana_english_index'),
            dbGet('dicts', 'kanji_char_reading_index'),
            dbGet('dicts', 'kanji_variant_map')
        ]).then(function(results) {
            return !!(
                Array.isArray(results[0]) && results[0].length > 0 &&
                results[1] && results[2] && results[3] && results[4] && results[5] &&
                results[6] && results[7]
            );
        });
    });
}

function preprocessText(text) {
    text = normalizeJapaneseVariants(String(text || ''));
    text = text
        .replace(/　/g, ' ')
        .replace(/[！]/g, '!')
        .replace(/[？]/g, '?')
        .replace(/[（]/g, '(')
        .replace(/[）]/g, ')')
        .replace(/[［]/g, '[')
        .replace(/[］]/g, ']')
        .replace(/[｛]/g, '{')
        .replace(/[｝]/g, '}')
        .replace(/[：]/g, ':')
        .replace(/[；]/g, ';')
        .replace(/[／]/g, '/')
        .replace(/[＆]/g, '&')
        .replace(/[・]/g, '-')
        .replace(/[、]/g, ', ')
        .replace(/[。]/g, '. ')
        .replace(/[～]/g, '~')
        .replace(/[×]/g, ' x ')
        .replace(/[\t\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return dbGet('dicts', 'jmdict_data').then(function(jmdictData) {
        if (Array.isArray(jmdictData) && jmdictData.length) {
            text = replaceMaskedTokensInText(text, jmdictData);
        }
        return normalizeOutputSpacing(text);
    }).catch(function() {
        return normalizeOutputSpacing(text);
    });
}

function kanaToRomajiCore(kana) {
    kana = String(kana || '');
    var map = {
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
        'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo',
        'ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo',
        'てぃ':'ti','でぃ':'di','でゅ':'dyu',
        'うぃ':'wi','うぇ':'we','うぉ':'wo',
        'ゔぁ':'va','ゔぃ':'vi','ゔ':'vu','ゔぇ':'ve','ゔぉ':'vo',
        'つぁ':'tsa','つぃ':'tsi','つぇ':'tse','つぉ':'tso',
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
        'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po'
    };
    kana = normalizeKana(kana);
    var result = '';
    var i = 0;
    while (i < kana.length) {
        var ch = kana.charAt(i);
        if (ch === 'っ') {
            var next2 = kana.slice(i + 1, i + 3);
            var next1 = kana.slice(i + 1, i + 2);
            var nextRomaji = map[next2] || map[next1] || '';
            if (nextRomaji) result += nextRomaji.charAt(0) === 'c' ? 'c' : nextRomaji.charAt(0);
            i++;
            continue;
        }
        if (ch === 'ー') {
            var last = result.charAt(result.length - 1);
            if (last === 'o') result += 'u';
            else if (/[aiue]/.test(last)) result += last;
            i++;
            continue;
        }
        var two = kana.slice(i, i + 2);
        if (map[two]) {
            result += map[two];
            i += 2;
            continue;
        }
        if (map[ch]) {
            result += map[ch];
            i++;
            continue;
        }
        result += ch;
        i++;
    }
    return result.replace(/tch/g, 'cch');
}

function romanizationTokenSurfaceLoose(token) {
    return (token && (token.surface_form || token.surface || token.basic_form || '')) || '';
}

function katakanaToHiraganaLoose(text) {
    text = String(text || '');
    return text.replace(/[\u30a1-\u30f6]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
}

function hasKatakana(text) {
    return /[\u30a1-\u30fa\u30fc]/.test(String(text || ''));
}

function hasHiragana(text) {
    return /[\u3041-\u3096]/.test(String(text || ''));
}

function isMixedKanaCompoundSurface(text) {
    text = String(text || '');
    return hasKatakana(text) && hasHiragana(text);
}

function isCompoundLookupJoinableToken(token) {
    var surface = romanizationTokenSurfaceLoose(token);
    var pos = (token && token.pos) || '';
    var detail = (token && token.pos_detail_1) || '';
    if (!surface) return false;
    if (pos === '記号' || pos === '助詞') return false;
    if (detail === '空白') return false;
    return /[\u3041-\u3096\u30a1-\u30fa\u30fc\u4e00-\u9fff々]/.test(surface);
}

function buildCompoundLookupCandidate(tokens, start, endExclusive) {
    var surface = '';
    var reading = '';
    var count = 0;

    for (var i = start; i < endExclusive; i++) {
        var token = tokens[i];
        if (!isCompoundLookupJoinableToken(token)) return null;
        var tokenText = romanizationTokenSurfaceLoose(token);
        var tokenReading = (token && (token.reading || token.pronunciation || token.surface_form || token.surface)) || tokenText || '';
        surface += tokenText;
        reading += tokenReading;
        count++;
    }

    if (count < 2) return null;

    return {
        surface: surface,
        reading: reading,
        tokenCount: count,
        normalizedSurface: katakanaToHiraganaLoose(surface),
        normalizedReading: katakanaToHiraganaLoose(reading)
    };
}

function findMixedKanaCompoundMatch(tokens, start, indexes) {
    if (!tokens || start >= tokens.length) return null;
    if (!isCompoundLookupJoinableToken(tokens[start])) return null;

    var maxTokens = Math.min(tokens.length, start + 4);

    for (var end = maxTokens; end > start + 1; end--) {
        var candidate = buildCompoundLookupCandidate(tokens, start, end);
        if (!candidate) continue;

        if (!isMixedKanaCompoundSurface(candidate.surface)) continue;

        traceRomanization('processTokensRewritten:mixed_kana_compound:candidate', {
            start: start,
            endExclusive: end,
            surface: candidate.surface,
            reading: candidate.reading,
            normalizedSurface: candidate.normalizedSurface,
            normalizedReading: candidate.normalizedReading
        });

        var entry = findBestDictionaryEntry(candidate.surface, candidate.reading, indexes, {
            preferProperName: false
        });

        if (entry) {
            traceRomanization('processTokensRewritten:mixed_kana_compound:hit', {
                start: start,
                endExclusive: end,
                surface: candidate.surface,
                reading: candidate.reading,
                normalizedSurface: candidate.normalizedSurface,
                normalizedReading: candidate.normalizedReading,
                expression: entry.expression || '',
                entryReading: entry.reading || '',
                bestEnglish: entry.bestEnglish || ''
            });

            return {
                start: start,
                endExclusive: end,
                surface: candidate.surface,
                reading: candidate.reading,
                normalizedSurface: candidate.normalizedSurface,
                normalizedReading: candidate.normalizedReading,
                entry: entry
            };
        }

        traceRomanization('processTokensRewritten:mixed_kana_compound:miss', {
            start: start,
            endExclusive: end,
            surface: candidate.surface,
            reading: candidate.reading,
            normalizedSurface: candidate.normalizedSurface,
            normalizedReading: candidate.normalizedReading
        });
    }

    return null;
}

function romanizationTokenReadingLoose(token) {
    return (token && (token.reading || token.pronunciation || token.surface_form || token.surface || token.basic_form || '')) || '';
}

function containsKanjiLoose(text) {
    return /[\u3400-\u4dbf\u4e00-\u9fff々〆ヵヶ]/.test(String(text || ''));
}

function isRomanizationBreakToken(token) {
    var surface = romanizationTokenSurfaceLoose(token);
    var pos = (token && token.pos) || '';
    var detail = (token && token.pos_detail_1) || '';

    if (!surface) return true;
    if (detail === '空白') return true;
    if (pos === '記号' || pos === '助詞' || pos === '助動詞' || pos === '接続詞' || pos === '感動詞') return true;

    return false;
}

function isKanjiNounLikeStarterToken(token) {
    var surface = romanizationTokenSurfaceLoose(token);
    var pos = (token && token.pos) || '';

    if (isRomanizationBreakToken(token)) return false;
    if (pos !== '名詞') return false;
    if (!containsKanjiLoose(surface)) return false;

    return true;
}

function canExtendKanjiNounChainToken(token) {
    var surface = romanizationTokenSurfaceLoose(token);
    var pos = (token && token.pos) || '';

    if (isRomanizationBreakToken(token)) return false;
    if (pos !== '名詞') return false;
    if (!containsKanjiLoose(surface)) return false;

    return true;
}

function isDerivationalSuffixLikeToken(token) {
    var surface = romanizationTokenSurfaceLoose(token);
    var detail = (token && token.pos_detail_1) || '';

    return !!(
        detail === '接尾' ||
        surface === '化' ||
        surface === '性' ||
        surface === '版' ||
        surface === '型' ||
        surface === '系' ||
        surface === '者' ||
        surface === '用' ||
        surface === '的'
    );
}

function isStrongStandaloneNounToken(token, indexes) {
    var surface = romanizationTokenSurfaceLoose(token);
    var reading = romanizationTokenReadingLoose(token);
    var pos = (token && token.pos) || '';
    var detail = (token && token.pos_detail_1) || '';

    if (isRomanizationBreakToken(token)) return false;
    if (pos !== '名詞') return false;
    if (surface.length === 1 && isDerivationalSuffixLikeToken(token)) return false;

    if (containsKanjiLoose(surface) && surface.length >= 2) return true;
    if (detail === 'サ変接続' || detail === '固有名詞' || detail === '一般') return true;

    try {
        var entry = findBestDictionaryEntry(surface, reading, indexes, {
            preferProperName: false
        });
        if (entry && (entry.reading || entry.expression || entry.bestEnglish)) return true;
    } catch (e) {}

    return false;
}

function scanKanjiNounChainSpan(tokens, start) {
    if (!tokens || start >= tokens.length) return null;
    if (!isKanjiNounLikeStarterToken(tokens[start])) return null;

    var end = start + 1;
    while (end < tokens.length && canExtendKanjiNounChainToken(tokens[end])) {
        end++;
    }

    if (end - start < 2) return null;

    return {
        start: start,
        endExclusive: end
    };
}

function buildKanjiCompoundCandidate(tokens, start, endExclusive) {
    var surface = '';
    var reading = '';
    var items = [];

    for (var i = start; i < endExclusive; i++) {
        var token = tokens[i];
        var tokenSurface = romanizationTokenSurfaceLoose(token);
        var tokenReading = romanizationTokenReadingLoose(token);

        surface += tokenSurface;
        reading += tokenReading;

        items.push({
            index: i,
            surface: tokenSurface,
            reading: tokenReading,
            pos: (token && token.pos) || '',
            detail: (token && token.pos_detail_1) || ''
        });
    }

    return {
        start: start,
        endExclusive: endExclusive,
        tokenCount: endExclusive - start,
        surface: surface,
        reading: reading,
        items: items
    };
}

function normalizeKanaReadingLoose(text) {
    text = String(text || '');
    text = text.replace(/[\s\u3000]+/g, '');
    text = text.replace(/[・･·]/g, '');
    text = text.replace(/[()（）\[\]{}【】「」『』]/g, '');
    return text;
}

function isKanaOnlyLoose(text) {
    text = normalizeKanaReadingLoose(text);
    return !!text && /^[ぁ-ゖゝゞァ-ヺー]+$/.test(text);
}

function collectKanaStringsLoose(value, out, depth) {
    if (depth > 3 || value == null) return;

    if (typeof value === 'string') {
        var normalized = normalizeKanaReadingLoose(value);
        if (isKanaOnlyLoose(normalized)) out.push(normalized);
        return;
    }

    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
            collectKanaStringsLoose(value[i], out, depth + 1);
        }
        return;
    }

    if (typeof value === 'object') {
        var preferredKeys = [
            'reading', 'readings', 'kana', 'kanas',
            'onyomi', 'onYomi', 'on', 'on_readings', 'ja_on',
            'kunyomi', 'kunYomi', 'kun', 'kun_readings', 'ja_kun',
            'nanori', 'meanings'
        ];

        for (var j = 0; j < preferredKeys.length; j++) {
            var key = preferredKeys[j];
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                collectKanaStringsLoose(value[key], out, depth + 1);
            }
        }

        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) {
            var dynamicKey = keys[k];
            if (preferredKeys.indexOf(dynamicKey) >= 0) continue;
            collectKanaStringsLoose(value[dynamicKey], out, depth + 1);
        }
    }
}

function uniqueKanaStringsLoose(values) {
    var out = [];
    var seen = {};
    for (var i = 0; i < values.length; i++) {
        var value = normalizeKanaReadingLoose(values[i]);
        if (!value) continue;
        if (!isKanaOnlyLoose(value)) continue;
        if (seen[value]) continue;
        seen[value] = true;
        out.push(value);
    }
    return out;
}

function choosePreferredKanaReadingLoose(values) {
    values = uniqueKanaStringsLoose(values || []);
    if (!values.length) return '';

    values.sort(function(a, b) {
        var aKatakana = /[ァ-ヺ]/.test(a) ? 1 : 0;
        var bKatakana = /[ァ-ヺ]/.test(b) ? 1 : 0;
        if (aKatakana !== bKatakana) return bKatakana - aKatakana;
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : (a > b ? 1 : 0);
    });

    return values[0] || '';
}

function lookupKanjiCharReadingsLoose(ch, indexes) {
    var candidates = [];
    var containers = [];

    if (indexes && typeof indexes === 'object') {
        containers.push(
            indexes.kanjiCharReadingIndex,
            indexes.kanjiCharReadings,
            indexes.kanjidicByLiteral,
            indexes.kanjidicLiteralMap,
            indexes.kanjidicByKanji,
            indexes.kanjiReadingsByChar,
            indexes.kanjiIndex,
            indexes.kanjiMap
        );
    }

    for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        if (!container || typeof container !== 'object') continue;

        var value = null;
        if (Object.prototype.hasOwnProperty.call(container, ch)) {
            value = container[ch];
        } else if (container.get && typeof container.get === 'function') {
            try { value = container.get(ch); } catch (e) {}
        }

        if (value != null) {
            collectKanaStringsLoose(value, candidates, 0);
        }
    }

    return uniqueKanaStringsLoose(candidates);
}

function resolveKanjiSurfaceByCharReadingsLoose(surface, indexes) {
    surface = String(surface || '');
    if (!surface) return '';

    var out = '';
    for (var i = 0; i < surface.length; i++) {
        var ch = surface.charAt(i);

        if (!containsKanjiLoose(ch)) {
            out += ch;
            continue;
        }

        var readings = lookupKanjiCharReadingsLoose(ch, indexes);
        var chosen = choosePreferredKanaReadingLoose(readings);

        if (!chosen) {
            return '';
        }

        out += chosen;
    }

    return normalizeKanaReadingLoose(out);
}

function resolveKanjiCompoundTokenReading(token, indexes) {
    var surface = romanizationTokenSurfaceLoose(token);
    var rawReading = romanizationTokenReadingLoose(token);
    var detail = (token && token.pos_detail_1) || '';
    var normalizedRaw = normalizeKanaReadingLoose(rawReading);
    var rawValid = !!normalizedRaw && isKanaOnlyLoose(normalizedRaw) && !containsKanjiLoose(normalizedRaw);

    if (!containsKanjiLoose(surface)) {
        return {
            surface: surface,
            reading: rawValid ? normalizedRaw : rawReading,
            rawReading: rawReading,
            source: 'token-non-kanji'
        };
    }

    if (detail === '固有名詞') {
        var properNameChainReading = resolveKanjiSurfaceByCharReadingsLoose(surface, indexes);
        if (properNameChainReading) {
            return {
                surface: surface,
                reading: properNameChainReading,
                rawReading: rawReading,
                source: 'char-index-propername-override'
            };
        }
    }

    if (surface.length === 1 && (!rawValid || rawReading === surface || containsKanjiLoose(rawReading))) {
        var singleCharReading = resolveKanjiSurfaceByCharReadingsLoose(surface, indexes);
        if (singleCharReading) {
            return {
                surface: surface,
                reading: singleCharReading,
                rawReading: rawReading,
                source: 'char-index-single-kanji'
            };
        }
    }

    if (surface.length >= 2 || !rawValid || rawReading === surface || containsKanjiLoose(rawReading)) {
        try {
            var entry = findBestDictionaryEntry(surface, '', indexes, {
                preferProperName: false
            });
            var entryReading = normalizeKanaReadingLoose(entry && entry.reading);
            if (entryReading && isKanaOnlyLoose(entryReading) && !containsKanjiLoose(entryReading)) {
                return {
                    surface: surface,
                    reading: entryReading,
                    rawReading: rawReading,
                    source: 'dictionary-reading'
                };
            }
        } catch (e) {}
    }

    if (rawValid && detail !== '固有名詞') {
        return {
            surface: surface,
            reading: normalizedRaw,
            rawReading: rawReading,
            source: 'token-reading'
        };
    }

    var charReading = resolveKanjiSurfaceByCharReadingsLoose(surface, indexes);
    if (charReading) {
        return {
            surface: surface,
            reading: charReading,
            rawReading: rawReading,
            source: 'char-index'
        };
    }

    if (rawValid) {
        return {
            surface: surface,
            reading: normalizedRaw,
            rawReading: rawReading,
            source: 'token-reading-fallback'
        };
    }

    return {
        surface: surface,
        reading: surface,
        rawReading: rawReading,
        source: 'surface-fallback'
    };
}

function buildMergedReading(tokens, start, endExclusive, indexes) {
    var kana = '';
    var unresolved = [];
    var items = [];

    for (var i = start; i < endExclusive; i++) {
        var token = tokens[i];
        var surface = romanizationTokenSurfaceLoose(token);
        var resolved = resolveKanjiCompoundTokenReading(token, indexes);
        var resolvedReading = resolved && resolved.reading ? resolved.reading : romanizationTokenReadingLoose(token);

        if (!resolvedReading) {
            unresolved.push(surface);
            resolvedReading = surface;
        }

        if (containsKanjiLoose(resolvedReading)) {
            unresolved.push(surface);
        }

        kana += resolvedReading;
        items.push({
            index: i,
            surface: surface,
            rawReading: romanizationTokenReadingLoose(token),
            resolvedReading: resolvedReading,
            source: resolved && resolved.source ? resolved.source : 'unknown'
        });
    }

    return {
        kana: kana,
        unresolved: unresolved,
        items: items
    };
}

function findBestKanjiFallbackBoundary(tokens, start, endExclusive, indexes) {
    var best = null;

    for (var cut = endExclusive - 1; cut > start + 1; cut--) {
        var leftLast = tokens[cut - 1];
        var rightFirst = tokens[cut];
        var score = 0;
        var reasons = [];

        if (isDerivationalSuffixLikeToken(leftLast)) {
            score += 5;
            reasons.push('left_derivational_suffix');
        }

        if (isStrongStandaloneNounToken(rightFirst, indexes)) {
            score += 4;
            reasons.push('right_strong_standalone_noun');
        }

        if ((cut - start) >= 2) {
            score += 1;
            reasons.push('left_span_ge_2');
        }

        if ((endExclusive - cut) >= 1) {
            score += 1;
            reasons.push('right_tail_exists');
        }

        if (!best || score > best.score) {
            best = {
                start: start,
                endExclusive: cut,
                score: score,
                reasons: reasons
            };
        }
    }

    if (best && best.score >= 9) {
        return best;
    }

    var lastToken = tokens[endExclusive - 1];
    if ((endExclusive - start) >= 2 && !isStrongStandaloneNounToken(lastToken, indexes)) {
        return {
            start: start,
            endExclusive: endExclusive,
            score: 0,
            reasons: ['merge_full_span_safe']
        };
    }

    return null;
}

function findBestKanjiCompoundMatch(tokens, start, indexes) {
    var span = scanKanjiNounChainSpan(tokens, start);
    if (!span) return null;

    var fullCandidate = buildKanjiCompoundCandidate(tokens, span.start, span.endExclusive);

    traceRomanization('processTokensRewritten:kanji_compound:start', {
        start: start,
        surface: romanizationTokenSurfaceLoose(tokens[start]),
        reading: romanizationTokenReadingLoose(tokens[start])
    });

    traceRomanization('processTokensRewritten:kanji_compound:span', {
        start: span.start,
        endExclusive: span.endExclusive,
        surface: fullCandidate.surface,
        reading: fullCandidate.reading,
        tokenCount: fullCandidate.tokenCount
    });

    for (var end = span.endExclusive; end > start + 1; end--) {
        var candidate = buildKanjiCompoundCandidate(tokens, start, end);

        traceRomanization('processTokensRewritten:kanji_compound:candidate', {
            start: start,
            endExclusive: end,
            surface: candidate.surface,
            reading: candidate.reading,
            tokenCount: candidate.tokenCount
        });

        var entry = null;
        try {
            entry = findBestDictionaryEntry(candidate.surface, candidate.reading, indexes, {
                preferProperName: false
            });
        } catch (e) {}

        if (entry) {
            var acceptHit = false;
            var acceptReason = '';

            if (end === span.endExclusive) {
                acceptHit = true;
                acceptReason = 'full_span_dict_hit';
            } else if (
                end < span.endExclusive &&
                isDerivationalSuffixLikeToken(tokens[end - 1]) &&
                isStrongStandaloneNounToken(tokens[end], indexes)
            ) {
                acceptHit = true;
                acceptReason = 'prefix_before_strong_tail';
            }

            if (acceptHit) {
                traceRomanization('processTokensRewritten:kanji_compound:dict_hit', {
                    start: start,
                    endExclusive: end,
                    surface: candidate.surface,
                    reading: candidate.reading,
                    expression: entry.expression || '',
                    entryReading: entry.reading || '',
                    acceptReason: acceptReason
                });

                return {
                    start: start,
                    endExclusive: end,
                    surface: candidate.surface,
                    reading: (entry && entry.reading) || candidate.reading,
                    entry: entry,
                    method: 'dict'
                };
            }

            traceRomanization('processTokensRewritten:kanji_compound:dict_hit_deferred', {
                start: start,
                endExclusive: end,
                surface: candidate.surface,
                reading: candidate.reading,
                expression: entry.expression || '',
                entryReading: entry.reading || '',
                reason: 'hit_not_selected_due_to_chain_continuation'
            });
            continue;
        }

        traceRomanization('processTokensRewritten:kanji_compound:dict_miss', {
            start: start,
            endExclusive: end,
            surface: candidate.surface,
            reading: candidate.reading
        });
    }

    var boundary = findBestKanjiFallbackBoundary(tokens, start, span.endExclusive, indexes);
    if (!boundary) {
        traceRomanization('processTokensRewritten:kanji_compound:fallback_boundary:none', {
            start: start,
            endExclusive: span.endExclusive,
            surface: fullCandidate.surface,
            reading: fullCandidate.reading
        });
        return null;
    }

    traceRomanization('processTokensRewritten:kanji_compound:fallback_boundary', {
        fullSurface: fullCandidate.surface,
        fullReading: fullCandidate.reading,
        chosenSurface: buildKanjiCompoundCandidate(tokens, start, boundary.endExclusive).surface,
        chosenReading: buildKanjiCompoundCandidate(tokens, start, boundary.endExclusive).reading,
        start: start,
        endExclusive: boundary.endExclusive,
        reasons: boundary.reasons || [],
        score: boundary.score
    });

    var merged = buildMergedReading(tokens, start, boundary.endExclusive, indexes);
    var chosen = buildKanjiCompoundCandidate(tokens, start, boundary.endExclusive);

    traceRomanization('processTokensRewritten:kanji_compound:merged_reading', {
        start: start,
        endExclusive: boundary.endExclusive,
        surface: chosen.surface,
        mergedKana: merged && merged.kana ? merged.kana : '',
        unresolved: merged && merged.unresolved ? merged.unresolved : [],
        items: merged && merged.items ? merged.items : []
    });

    if (!merged || !merged.kana || containsKanjiLoose(merged.kana)) {
        traceRomanization('processTokensRewritten:kanji_compound:merged_reading_unresolved', {
            start: start,
            endExclusive: boundary.endExclusive,
            surface: chosen.surface,
            mergedKana: merged && merged.kana ? merged.kana : '',
            unresolved: merged && merged.unresolved ? merged.unresolved : []
        });
        return null;
    }

    return {
        start: start,
        endExclusive: boundary.endExclusive,
        surface: chosen.surface,
        reading: merged.kana,
        sourceKana: merged.kana,
        method: 'merged-reading'
    };
}

function normalizeLocalDictExactKey(text) {
    return String(text || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f]+/g, '')
        .replace(/[\s\u3000]+/g, ' ')
        .trim();
}

function getLocalDictionaryEntriesLoose() {
    var merged = [];
    var sources = [];

    if (typeof window !== 'undefined') {
        sources.push(
            window.localDictionaryEntries,
            window.localRomajiDictionary,
            window.romanizationLocalDictionary,
            window.romajiLocalDictionary,
            window.userDictionaryEntries,
            window.customDictionaryEntries,
            window.customRomajiDictionary
        );
    }

    if (typeof globalThis !== 'undefined') {
        sources.push(
            globalThis.localDictionaryEntries,
            globalThis.localRomajiDictionary,
            globalThis.romanizationLocalDictionary,
            globalThis.romajiLocalDictionary,
            globalThis.userDictionaryEntries,
            globalThis.customDictionaryEntries,
            globalThis.customRomajiDictionary
        );
    }

    for (var i = 0; i < sources.length; i++) {
        var src = sources[i];
        if (!src) continue;

        if (Array.isArray(src)) {
            merged = merged.concat(src);
            continue;
        }

        if (typeof src === 'object') {
            if (Array.isArray(src.entries)) {
                merged = merged.concat(src.entries);
                continue;
            }
            if (Array.isArray(src.items)) {
                merged = merged.concat(src.items);
                continue;
            }
            if (Array.isArray(src.list)) {
                merged = merged.concat(src.list);
                continue;
            }
        }
    }

    try {
        var userDicts = GM_getValue('user_dicts', {});
        if (userDicts && typeof userDicts === 'object') {
            Object.keys(userDicts).forEach(function(dictName) {
                var dictObj = userDicts[dictName];
                if (!dictObj || typeof dictObj !== 'object') return;

                Object.keys(dictObj).forEach(function(sourceKey) {
                    merged.push({
                        source: sourceKey,
                        target: dictObj[sourceKey],
                        enabled: true,
                        dictName: dictName
                    });
                });
            });
        }
    } catch (e) {}

    return merged;
}

function getLocalDictionaryEntrySourceLoose(entry) {
    return String(
        (entry && (
            entry.source ||
            entry.original ||
            entry.from ||
            entry.key ||
            entry.text ||
            entry.jp ||
            entry.ja
        )) || ''
    );
}

function getLocalDictionaryEntryTargetLoose(entry) {
    return String(
        (entry && (
            entry.target ||
            entry.replacement ||
            entry.to ||
            entry.value ||
            entry.romaji ||
            entry.en
        )) || ''
    );
}

function getLocalDictionaryEntryEnabledLoose(entry) {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.enabled === false) return false;
    if (entry.checked === false) return false;
    if (entry.active === false) return false;
    if (entry.disabled === true) return false;
    return true;
}

function getLocalDictionaryEntryOrderLoose(entry, fallbackIndex) {
    if (entry && typeof entry.order === 'number') return entry.order;
    if (entry && typeof entry.priority === 'number') return entry.priority;
    if (entry && typeof entry.index === 'number') return entry.index;
    return fallbackIndex;
}

function getPrioritizedLocalDictionaryEntriesLoose() {
    var merged = [];
    var userDicts = getUserDictsRaw();

    Object.keys(userDicts).sort(function(a, b) {
        return a.localeCompare(b);
    }).forEach(function(dictName) {
        var dictObj = userDicts[dictName];
        if (!dictObj || typeof dictObj !== 'object') return;

        Object.keys(dictObj).forEach(function(sourceKey) {
            var targetVal = dictObj[sourceKey];
            var normalizedSource = normalizeLocalDictExactKey(sourceKey);
            if (!normalizedSource || targetVal === undefined || targetVal === null || String(targetVal) === '') return;

            merged.push({
                source: sourceKey,
                target: String(targetVal),
                normalizedSource: normalizedSource,
                dictName: dictName,
                order: merged.length
            });
        });
    });

    return merged;
}

function findExactLocalDictionaryMatchLoose(text) {
    var normalizedText = normalizeLocalDictExactKey(text);
    if (!normalizedText) return null;

    var entries = getPrioritizedLocalDictionaryEntriesLoose();
    if (!entries || !entries.length) return null;

    var prepared = [];
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!getLocalDictionaryEntryEnabledLoose(entry)) continue;

        var source = getLocalDictionaryEntrySourceLoose(entry);
        var target = getLocalDictionaryEntryTargetLoose(entry);
        var normalizedSource = normalizeLocalDictExactKey(source);

        if (!normalizedSource || !target) continue;

        prepared.push({
            raw: entry,
            source: source,
            target: target,
            normalizedSource: normalizedSource,
            order: getLocalDictionaryEntryOrderLoose(entry, i)
        });
    }

    prepared.sort(function(a, b) {
        if (a.order !== b.order) return a.order - b.order;
        return 0;
    });

    for (var j = 0; j < prepared.length; j++) {
        var candidate = prepared[j];
        if (candidate.normalizedSource === normalizedText) {
            return candidate;
        }
    }

    return null;
}

function normalizeLocalDictInlineMatchText(text) {
    return normalizeOutputSpacing(
        normalizeJapaneseVariants(String(text || ''))
            .replace(/　/g, ' ')
            .replace(/[！]/g, '!')
            .replace(/[？]/g, '?')
            .replace(/[（]/g, '(')
            .replace(/[）]/g, ')')
            .replace(/[［]/g, '[')
            .replace(/[］]/g, ']')
            .replace(/[｛]/g, '{')
            .replace(/[｝]/g, '}')
            .replace(/[：]/g, ':')
            .replace(/[；]/g, ';')
            .replace(/[／]/g, '/')
            .replace(/[＆]/g, '&')
            .replace(/[・]/g, '-')
            .replace(/[、]/g, ', ')
            .replace(/[。]/g, '. ')
            .replace(/[～]/g, '~')
            .replace(/[×]/g, ' x ')
            .replace(/[\t\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

function getPreparedLocalDictionaryInlineEntriesLoose() {
    var entries = getPrioritizedLocalDictionaryEntriesLoose();
    var prepared = [];

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!getLocalDictionaryEntryEnabledLoose(entry)) continue;

        var rawSource = getLocalDictionaryEntrySourceLoose(entry);
        var rawTarget = getLocalDictionaryEntryTargetLoose(entry);
        var normalizedSource = normalizeLocalDictInlineMatchText(rawSource);
        var target = String(rawTarget || '');

        if (!normalizedSource || !target) continue;

        prepared.push({
            raw: entry,
            source: normalizedSource,
            target: target,
            order: getLocalDictionaryEntryOrderLoose(entry, i)
        });
    }

    prepared.sort(function(a, b) {
        if (a.order !== b.order) return a.order - b.order;
        if (a.source.length !== b.source.length) return b.source.length - a.source.length;
        return 0;
    });

    return prepared;
}

function applyLocalDictionaryExactReplacementsLoose(text) {
    var working = normalizeLocalDictInlineMatchText(text);
    if (!working) return working;

    var entries = getPreparedLocalDictionaryInlineEntriesLoose();
    if (!entries.length) return working;

    var out = '';
    var i = 0;
    var hits = [];

    while (i < working.length) {
        var matched = null;

        for (var j = 0; j < entries.length; j++) {
            var entry = entries[j];
            if (!entry.source) continue;
            if (working.substr(i, entry.source.length) === entry.source) {
                matched = entry;
                break;
            }
        }

        if (matched) {
            out += matched.target;
            hits.push({
                index: i,
                source: matched.source,
                target: matched.target,
                order: matched.order
            });
            i += matched.source.length;
        } else {
            out += working.charAt(i);
            i += 1;
        }
    }

    traceRomanization('convertToRomajiRewritten:local_dictionary_inline_scan', {
        input: text,
        normalizedInput: working,
        output: out,
        hits: hits
    });

    return out;
}

function processTokensRewritten(tokens) {
    return Promise.all([
        dbGet('dicts', 'jmdict_expression_index'),
        dbGet('dicts', 'jmdict_reading_index'),
        dbGet('dicts', 'jmdict_kana_normalized_index'),
        dbGet('dicts', 'jmdict_mixed_script_index'),
        dbGet('dicts', 'jmdict_katakana_english_index'),
        dbGet('dicts', 'kanji_char_reading_index'),
        dbGet('dicts', 'kanji_variant_map')
    ]).then(function(results) {
        var indexes = {
            expressionIndex: results[0] || {},
            readingIndex: results[1] || {},
            kanaNormalizedIndex: results[2] || {},
            mixedScriptIndex: results[3] || {},
            katakanaEnglishIndex: results[4] || {},
            kanjiCharReadingIndex: results[5] || {},
            variantMap: results[6] || {}
        };

        traceRomanization('processTokensRewritten:tokens', tokens.map(function(token, index) {
            return {
                index: index,
                surface: (token && (token.surface_form || token.surface || '')) || '',
                reading: (token && (token.reading || token.pronunciation || token.surface_form || token.surface || '')) || '',
                pos: (token && token.pos) || '',
                detail: (token && token.pos_detail_1) || ''
            };
        }));
        var parts = [];

        function pushWord(word) {
            word = String(word || '').trim();
            if (!word) return;
            if (parts.length && parts[parts.length - 1] !== ' ') parts.push(' ');
            parts.push(word);
        }

        function pushPunct(punct) {
            punct = String(punct || '');
            if (!punct) return;
            while (parts.length && parts[parts.length - 1] === ' ') parts.pop();
            parts.push(punct);
            parts.push(' ');
        }

        function tokenSurface(token) {
            return (token && (token.surface_form || token.surface || '')) || '';
        }

        function tokenReading(token) {
            return (token && (token.reading || token.pronunciation || tokenSurface(token))) || '';
        }

        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i] || {};
            var surface = tokenSurface(token);
            var reading = tokenReading(token);
            var pos = token.pos || '';
            var detail = token.pos_detail_1 || '';

            traceRomanization('processTokensRewritten:token', {
                index: i,
                surface: surface,
                reading: reading,
                pos: pos,
                detail: detail
            });

            if (!surface) continue;

            if (pos === '記号' && detail === '空白') {
                if (parts.length && parts[parts.length - 1] !== ' ') parts.push(' ');
                continue;
            }

            if (pos === '記号') {
                pushPunct(surface);
                continue;
            }

            if (isAsciiWord(surface) || isAllCapsWesternAbbr(surface)) {
                pushWord(surface);
                continue;
            }

            if (pos === '助詞') {
                var particleMap = { 'は': 'wa', 'へ': 'e', 'を': 'o' };
                pushWord(particleMap[surface] || kanaToRomajiCore(reading));
                continue;
            }

            if (surface === '本') {
                var prev = i > 0 ? (tokens[i - 1] || {}) : null;
                var prevPos = prev ? (prev.pos || '') : '';
                pushWord(prevPos === '名詞' || prevPos === '代名詞' ? 'bon' : 'hon');
                continue;
            }

            var properEntry = findBestDictionaryEntry(surface, reading, indexes, { preferProperName: true });
            if (properEntry && isProperNameEntry(properEntry)) {
                pushWord(properEntry.bestEnglish || kanaToRomajiCore(properEntry.reading || reading || surface));
                continue;
            }

            if (isPureNumericKanji(surface)) {
                var numericRomaji = convertNumericKanjiToReading(surface);
                if (numericRomaji) {
                    pushWord(numericRomaji);
                    continue;
                }
            }

            var mixedKanaCompound = findMixedKanaCompoundMatch(tokens, i, indexes);
            if (mixedKanaCompound) {
                var compoundReading = (mixedKanaCompound.entry && mixedKanaCompound.entry.reading) || mixedKanaCompound.reading || mixedKanaCompound.surface;
                var compoundRomaji = kanaToRomajiCore(compoundReading);

                traceRomanization('processTokensRewritten:mixed_kana_compound:chosen', {
                    start: i,
                    endExclusive: mixedKanaCompound.endExclusive,
                    surface: mixedKanaCompound.surface,
                    reading: mixedKanaCompound.reading,
                    normalizedSurface: mixedKanaCompound.normalizedSurface,
                    normalizedReading: mixedKanaCompound.normalizedReading,
                    expression: mixedKanaCompound.entry && mixedKanaCompound.entry.expression ? mixedKanaCompound.entry.expression : '',
                    entryReading: mixedKanaCompound.entry && mixedKanaCompound.entry.reading ? mixedKanaCompound.entry.reading : '',
                    output: compoundRomaji
                });

                pushWord(compoundRomaji);
                i = mixedKanaCompound.endExclusive - 1;
                continue;
            }

            var kanjiCompound = findBestKanjiCompoundMatch(tokens, i, indexes);
            if (kanjiCompound) {
                var kanjiCompoundReading = (kanjiCompound.entry && kanjiCompound.entry.reading) || kanjiCompound.reading || kanjiCompound.sourceKana || kanjiCompound.surface;
                var kanjiCompoundRomaji = kanaToRomajiCore(kanjiCompoundReading);

                traceRomanization('processTokensRewritten:kanji_compound:chosen', {
                    start: i,
                    endExclusive: kanjiCompound.endExclusive,
                    surface: kanjiCompound.surface,
                    reading: kanjiCompoundReading,
                    method: kanjiCompound.method || '',
                    output: kanjiCompoundRomaji
                });

                pushWord(kanjiCompoundRomaji);
                i = kanjiCompound.endExclusive - 1;
                continue;
            }

            if (isPureKatakana(surface)) {
                var merged = surface;
                var end = i + 1;
                while (end < tokens.length) {
                    var nextSurface = tokenSurface(tokens[end]);
                    var nextPos = (tokens[end] && tokens[end].pos) || '';
                    var nextDetail = (tokens[end] && tokens[end].pos_detail_1) || '';
                    if (!nextSurface || nextPos === '記号' || nextPos === '助詞' || nextDetail === '空白' || !isPureKatakana(nextSurface)) break;
                    merged += nextSurface;
                    end++;
                }

                var katakanaProperEntry = findBestDictionaryEntry(merged, merged, indexes, { preferProperName: true });
                if (katakanaProperEntry && isProperNameEntry(katakanaProperEntry) && katakanaProperEntry.bestEnglish) {
                    traceRomanization('processTokensRewritten:katakana:proper_name_english', {
                        index: i,
                        surface: surface,
                        merged: merged,
                        bestEnglish: katakanaProperEntry.bestEnglish,
                        expression: katakanaProperEntry.expression || '',
                        reading: katakanaProperEntry.reading || ''
                    });
                    pushWord(katakanaProperEntry.bestEnglish);
                    i = end - 1;
                    continue;
                }

                traceRomanization('processTokensRewritten:katakana:romaji_only', {
                    index: i,
                    surface: surface,
                    merged: merged,
                    reason: 'disable_generic_katakana_english_translation'
                });

                pushWord(kanaToRomajiCore(merged));
                i = end - 1;
                continue;
            }

            if (containsKanji(surface)) {
                var kanjiResolved = romanizeByDictionaryOrFallback(surface, reading, indexes, {});
                pushWord(kanjiResolved || kanaToRomajiCore(reading || surface));
                continue;
            }

            pushWord(kanaToRomajiCore(reading || surface));
        }

        return normalizeOutputSpacing(parts.join(''));
    });
}

function applyRomajiRulesRewritten(romaji) {
    var macronMap = { 'ā': 'aa', 'ē': 'ee', 'ī': 'ii', 'ō': 'ou', 'ū': 'uu', 'Ā': 'Aa', 'Ē': 'Ee', 'Ī': 'Ii', 'Ō': 'Ou', 'Ū': 'Uu' };
    romaji = String(romaji || '').replace(/[āēīōūĀĒĪŌŪ]/g, function(ch) {
        return macronMap[ch] || ch;
    });

    romaji = romaji
        .replace(/(^|\s)ha(?=\s|$)/g, '$1wa')
        .replace(/(^|\s)he(?=\s|$)/g, '$1e')
        .replace(/(^|\s)wo(?=\s|$)/g, '$1o')
        .replace(/tch/gi, 'cch')
        .replace(/([A-Za-z])\s+(san|chan|sama|kun)(?=\s|$|[^A-Za-z])/gi, function(_, head, honorific) {
            return head + '-' + honorific.toLowerCase();
        })
        .replace(/\s+/g, ' ')
        .trim();

    return normalizeOutputSpacing(romaji);
}

function titleCaseSimple(word) {
    if (!word) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function formatOutput(text) {
    text = String(text || '');

    text = text.replace(/[A-Za-z][A-Za-z0-9'._&+\/-]*/g, function(word) {
        if (isAllCapsWesternAbbr(word)) return word;
        if (/[A-Z]/.test(word) && word !== word.toLowerCase()) return word;
        var honorificMatch = word.match(/^([A-Za-z][A-Za-z0-9'._&+\/]*)-(san|chan|sama|kun)$/i);
        if (honorificMatch) return titleCaseSimple(honorificMatch[1]) + '-' + honorificMatch[2].toLowerCase();
        if (/^[a-z][a-z'._&+\/-]*$/.test(word)) return titleCaseSimple(word);
        return word;
    });

    text = text.replace(/^[a-z]/, function(ch) { return ch.toUpperCase(); });
    return normalizeOutputSpacing(text);
}

var ENABLE_ROMANIZATION_TRACE = true;

function traceRomanization(stage, payload) {
    if (!ENABLE_ROMANIZATION_TRACE) return;
    try { _debug('[RomanizationTrace]', stage, payload); } catch (e) {}
    return;
    if (!ENABLE_ROMANIZATION_TRACE) return;
    try { _debug('[RomanizationTrace]', stage, payload); } catch (e) {}
}

function setRomanizationButtonError(btn, text) {
    if (!btn) return;
    btn.textContent = text || '轉換失敗';
    btn.style.backgroundColor = '#CC0000';
    btn.style.color = '#FFFFFF';
    setTimeout(function() {
        btn.disabled = false;
        btn.textContent = 'Romanization';
        btn.style.backgroundColor = '#E0DED3';
        btn.style.color = '#5C0D12';
    }, 2000);
}

function convertToRomajiRewritten(text, romanBtn, outputField) {
    if (!text || !text.trim()) {
        warnLog('Romanization', '輸入文字為空');
        return;
    }

    romanBtn.disabled = true;
    romanBtn.textContent = '初始化中...';

    traceRomanization('convertToRomajiRewritten:input', { text: text });

    var exactLocalDictionaryMatch = findExactLocalDictionaryMatchLoose(text);
    if (exactLocalDictionaryMatch) {
        var exactOutput = String(exactLocalDictionaryMatch.target || '');

        traceRomanization('convertToRomajiRewritten:local_dictionary_exact_match', {
            input: text,
            preprocessed: text,
            source: exactLocalDictionaryMatch.source,
            normalizedSource: exactLocalDictionaryMatch.normalizedSource,
            target: exactLocalDictionaryMatch.target,
            order: exactLocalDictionaryMatch.order
        });

        outputField.value = exactOutput;
        opLog('羅馬字轉換', { input: text, output: exactOutput, via: 'local_dictionary_exact_match' });

        romanBtn.disabled = false;
        romanBtn.textContent = 'Romanization';
        romanBtn.style.backgroundColor = '#E0DED3';
        romanBtn.style.color = '#5C0D12';
        return;
    }

    var localDictionaryFirstPass = applyLocalDictionaryExactReplacementsLoose(text);

    traceRomanization('convertToRomajiRewritten:local_dictionary_first_pass', {
        input: text,
        inlineReplaced: localDictionaryFirstPass
    });

    preprocessText(localDictionaryFirstPass).then(function(preprocessed) {
        traceRomanization('convertToRomajiRewritten:preprocessed', {
            preprocessed: preprocessed
        });

        var exactLocalDictionaryMatch = null;
        if (exactLocalDictionaryMatch) {
            var exactOutput = String(exactLocalDictionaryMatch.target || '');

            traceRomanization('convertToRomajiRewritten:local_dictionary_exact_match', {
                input: text,
                preprocessed: preprocessed,
                source: exactLocalDictionaryMatch.source,
                normalizedSource: exactLocalDictionaryMatch.normalizedSource,
                target: exactLocalDictionaryMatch.target,
                order: exactLocalDictionaryMatch.order
            });

            outputField.value = exactOutput;
            opLog('羅馬字轉換', { input: text, output: exactOutput, via: 'local_dictionary_exact_match' });

            romanBtn.disabled = false;
            romanBtn.textContent = 'Romanization';
            romanBtn.style.backgroundColor = '#E0DED3';
            romanBtn.style.color = '#5C0D12';
            return null;
        }

        var inlineReplaced = preprocessed;

        traceRomanization('convertToRomajiRewritten:preprocessed_after_local_dictionary', {
            preprocessed: preprocessed,
            inlineReplaced: inlineReplaced
        });

        return initKuroshiro().then(function(success) {
            if (!success && !_kuroshiroReady) throw new Error('Kuroshiro 初始化失敗');
            romanBtn.textContent = '轉換中...';
            return _kuroshiro._analyzer.parse(inlineReplaced);
        }).then(function(tokens) {
            return processTokensRewritten(tokens);
        }).then(function(raw) {
            traceRomanization('convertToRomajiRewritten:raw', { raw: raw });
            var fixed = applyRomajiRulesRewritten(raw);
            traceRomanization('convertToRomajiRewritten:fixed', { fixed: fixed });
            var formatted = formatOutput(fixed);
            traceRomanization('convertToRomajiRewritten:formatted', { formatted: formatted });
            outputField.value = formatted;
            opLog('羅馬字轉換', { input: text, output: formatted });
            romanBtn.disabled = false;
            romanBtn.textContent = 'Romanization';
            romanBtn.style.backgroundColor = '#E0DED3';
            romanBtn.style.color = '#5C0D12';
            return formatted;
        });
    }).catch(function(err) {
        errorLog('Romanization', '轉換失敗', err && (err.message || err));
        setRomanizationButtonError(romanBtn, '轉換失敗');
    });
}

function cleanExternalDictRewritten(dictKey, ctx) {
    var titleMap = { kuromoji: 'Kuromoji', jmdict: 'JMdict + KANJIDIC' };
    if (!confirm('確認要清空 ' + titleMap[dictKey] + ' 外部字典快取嗎？\n\n將刪除該字典在 IndexedDB 中的所有內容\n此操作無法復原')) return;
    if (!confirm('二次確認：將永久清空 ' + titleMap[dictKey] + ' 快取\n確定繼續？')) return;

    var deleteKeys = [];
    if (dictKey === 'kuromoji') {
        deleteKeys = [
            'base.dat.gz','check.dat.gz','tid.dat.gz','tid_pos.dat.gz',
            'tid_map.dat.gz','cc.dat.gz','unk.dat.gz','unk_pos.dat.gz',
            'unk_map.dat.gz','unk_char.dat.gz','unk_compat.dat.gz','unk_invoke.dat.gz',
            'kuromoji_download_time'
        ];
    } else if (dictKey === 'jmdict') {
        deleteKeys = JMDICT_INDEX_KEYS.concat(KANJIDIC_INDEX_KEYS);
    }

    opLog('Clean 外部字典', { dictType: titleMap[dictKey], keys: deleteKeys });

    Promise.all(deleteKeys.map(function(key) {
        return dbDelete('dicts', key).catch(function() { return null; });
    })).then(function() {
        if (ctx && typeof ctx.renderKuromojiItems === 'function') ctx.renderKuromojiItems();
        if (ctx && typeof ctx.renderJMdictItems === 'function') ctx.renderJMdictItems();
        if (ctx && ctx.currentSelection && ctx.currentSelection.type === 'external' && ctx.currentSelection.key === dictKey && typeof ctx.setActiveExternalDict === 'function') {
            ctx.setActiveExternalDict(dictKey);
        } else if (ctx && typeof ctx.renderCurrentSelectionSilently === 'function') {
            ctx.renderCurrentSelectionSilently();
        }
    });
}

function makeExternalStatusRow(label, statusText, statusOk) {
    var row = document.createElement('div');
    row.style.cssText = 'font-size: 8.5pt; padding: 3px 8px 3px 32px; border-bottom: 1px solid rgba(92,13,18,0.1); color: #333; background: #E0DED3; display: flex; justify-content: space-between; align-items: center;';
    var left = document.createElement('span');
    left.textContent = label;
    var right = document.createElement('span');
    right.textContent = statusText;
    right.style.color = statusOk ? '#007700' : '#CC0000';
    row.appendChild(left);
    row.appendChild(right);
    return row;
}

function renderJMdictItemsRewritten(jmdictItemsDiv) {
    if (!jmdictItemsDiv) return;
    var renderToken = Date.now() + '_' + Math.random().toString(36).slice(2);
    jmdictItemsDiv.__renderToken = renderToken;
    Promise.all([
        dbGet('dicts', 'jmdict_data'),
        dbGet('dicts', 'jmdict_download_time'),
        dbGet('dicts', 'jmdict_expression_index'),
        dbGet('dicts', 'jmdict_reading_index'),
        dbGet('dicts', 'jmdict_kana_normalized_index'),
        dbGet('dicts', 'jmdict_mixed_script_index'),
        dbGet('dicts', 'jmdict_katakana_english_index'),
        dbGet('dicts', 'kanjidic_data'),
        dbGet('dicts', 'kanjidic_download_time'),
        dbGet('dicts', 'kanji_char_reading_index'),
        dbGet('dicts', 'kanji_variant_map')
    ]).then(function(results) {
        if (jmdictItemsDiv.__renderToken !== renderToken) return;
        jmdictItemsDiv.innerHTML = '';
        var jmdictData = results[0];
        var jmdictTime = results[1];
        var expIndex = results[2];
        var readingIndex = results[3];
        var kanaIndex = results[4];
        var mixedIndex = results[5];
        var katakanaEnglish = results[6];
        var kanjidicData = results[7];
        var kanjidicTime = results[8];
        var kanjiReading = results[9];
        var variantMap = results[10];

        var jmdictOk = Array.isArray(jmdictData) && jmdictData.length > 0;
        var kanjidicOk = Array.isArray(kanjidicData) && kanjidicData.length > 0;
        var allIndexOk = !!(expIndex && readingIndex && kanaIndex && mixedIndex && katakanaEnglish && kanjiReading && variantMap);

        jmdictItemsDiv.appendChild(makeExternalStatusRow('JMdict', jmdictOk ? ('✓ ' + jmdictData.length + ' entries' + (jmdictTime ? ' / ' + new Date(jmdictTime).toLocaleDateString() : '')) : '✗ 未下載', jmdictOk));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('KANJIDIC', kanjidicOk ? ('✓ ' + kanjidicData.length + ' entries' + (kanjidicTime ? ' / ' + new Date(kanjidicTime).toLocaleDateString() : '')) : '✗ 未下載', kanjidicOk));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Expression Index', expIndex ? '✓' : '✗', !!expIndex));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Reading Index', readingIndex ? '✓' : '✗', !!readingIndex));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Kana-Normalized Index', kanaIndex ? '✓' : '✗', !!kanaIndex));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Mixed-Script Index', mixedIndex ? '✓' : '✗', !!mixedIndex));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Katakana-English Index', katakanaEnglish ? '✓' : '✗', !!katakanaEnglish));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Kanji Char Reading Index', kanjiReading ? '✓' : '✗', !!kanjiReading));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Variant Map', variantMap ? '✓' : '✗', !!variantMap));
        jmdictItemsDiv.appendChild(makeExternalStatusRow('Overall', allIndexOk && jmdictOk && kanjidicOk ? '✓ READY' : '✗ INCOMPLETE', allIndexOk && jmdictOk && kanjidicOk));
    });
}

function downloadJsonBundle(url) {
    dictDebug('downloadJsonBundle:start', url);
    return new Promise(function(resolve, reject) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'text',
            anonymous: true,
            redirect: 'follow',
            onload: function(resp) {
                dictDebug('downloadJsonBundle:onload', {
                    url: url,
                    status: resp.status,
                    textLength: resp.responseText ? resp.responseText.length : 0
                });
                if (resp.status < 200 || resp.status >= 300) {
                    reject(new Error('HTTP ' + resp.status + ' ' + url));
                    return;
                }
                try {
                    resolve(JSON.parse(resp.responseText));
                } catch (err) {
                    reject(new Error('JSON parse failed: ' + (err && err.message ? err.message : err)));
                }
            },
            onerror: function(err) {
                dictDebug('downloadJsonBundle:onerror', {
                    url: url,
                    error: err && (err.error || err.message || err)
                });
                reject(new Error((err && err.error) || ('下載失敗: ' + url)));
            },
            ontimeout: function() {
                dictDebug('downloadJsonBundle:ontimeout', { url: url });
                reject(new Error('下載超時: ' + url));
            }
        });
    });
}

function normalizePrebuiltJMdictBundle(bundle) {
    bundle = bundle || {};
    var entries = bundle.entries || bundle.jmdict_data || bundle.data || [];
    var expressionIndex = bundle.expressionIndex || bundle.jmdict_expression_index || (bundle.indexes && bundle.indexes.expressionIndex) || null;
    var readingIndex = bundle.readingIndex || bundle.jmdict_reading_index || (bundle.indexes && bundle.indexes.readingIndex) || null;
    var kanaNormalizedIndex = bundle.kanaNormalizedIndex || bundle.jmdict_kana_normalized_index || (bundle.indexes && bundle.indexes.kanaNormalizedIndex) || null;
    var mixedScriptIndex = bundle.mixedScriptIndex || bundle.jmdict_mixed_script_index || (bundle.indexes && bundle.indexes.mixedScriptIndex) || null;
    var katakanaEnglishIndex = bundle.katakanaEnglishIndex || bundle.jmdict_katakana_english_index || (bundle.indexes && bundle.indexes.katakanaEnglishIndex) || null;

    if ((!expressionIndex || !readingIndex || !kanaNormalizedIndex || !mixedScriptIndex || !katakanaEnglishIndex) && Array.isArray(entries) && entries.length) {
        var built = buildJMdictIndexes(entries);
        expressionIndex = expressionIndex || built.expressionIndex;
        readingIndex = readingIndex || built.readingIndex;
        kanaNormalizedIndex = kanaNormalizedIndex || built.kanaNormalizedIndex;
        mixedScriptIndex = mixedScriptIndex || built.mixedScriptIndex;
        katakanaEnglishIndex = katakanaEnglishIndex || built.katakanaEnglishIndex;
    }

    return {
        entries: entries,
        expressionIndex: expressionIndex,
        readingIndex: readingIndex,
        kanaNormalizedIndex: kanaNormalizedIndex,
        mixedScriptIndex: mixedScriptIndex,
        katakanaEnglishIndex: katakanaEnglishIndex
    };
}

function normalizePrebuiltKANJIDICBundle(bundle) {
    bundle = bundle || {};
    var entries = bundle.entries || bundle.kanjidic_data || bundle.data || [];
    var kanjiCharReadingIndex = bundle.kanjiCharReadingIndex || bundle.kanji_char_reading_index || (bundle.indexes && bundle.indexes.kanjiCharReadingIndex) || null;
    var variantMap = bundle.variantMap || bundle.kanji_variant_map || (bundle.indexes && bundle.indexes.variantMap) || null;

    if ((!kanjiCharReadingIndex || !variantMap) && Array.isArray(entries) && entries.length) {
        var built = buildKANJIDICIndexes(entries);
        kanjiCharReadingIndex = kanjiCharReadingIndex || built.kanjiCharReadingIndex;
        variantMap = variantMap || built.variantMap;
    }

    return {
        entries: entries,
        kanjiCharReadingIndex: kanjiCharReadingIndex,
        variantMap: variantMap
    };
}

function savePrebuiltJMdictBundle(bundle) {
    var normalized = normalizePrebuiltJMdictBundle(bundle);
    dictDebug('savePrebuiltJMdictBundle:normalized', {
        entries: Array.isArray(normalized.entries) ? normalized.entries.length : 0,
        hasExpressionIndex: !!normalized.expressionIndex,
        hasReadingIndex: !!normalized.readingIndex,
        hasKanaNormalizedIndex: !!normalized.kanaNormalizedIndex,
        hasMixedScriptIndex: !!normalized.mixedScriptIndex,
        hasKatakanaEnglishIndex: !!normalized.katakanaEnglishIndex
    });

    if (!Array.isArray(normalized.entries) || !normalized.entries.length) {
        throw new Error('預建 JMdict bundle 缺少 entries');
    }

    return Promise.all([
        dbSet('dicts', 'jmdict_data', normalized.entries),
        dbSet('dicts', 'jmdict_expression_index', normalized.expressionIndex || {}),
        dbSet('dicts', 'jmdict_reading_index', normalized.readingIndex || {}),
        dbSet('dicts', 'jmdict_kana_normalized_index', normalized.kanaNormalizedIndex || {}),
        dbSet('dicts', 'jmdict_mixed_script_index', normalized.mixedScriptIndex || {}),
        dbSet('dicts', 'jmdict_katakana_english_index', normalized.katakanaEnglishIndex || {}),
        dbSet('dicts', 'jmdict_download_time', Date.now())
    ]);
}

function savePrebuiltKANJIDICBundle(bundle) {
    var normalized = normalizePrebuiltKANJIDICBundle(bundle);
    dictDebug('savePrebuiltKANJIDICBundle:normalized', {
        entries: Array.isArray(normalized.entries) ? normalized.entries.length : 0,
        hasKanjiCharReadingIndex: !!normalized.kanjiCharReadingIndex,
        hasVariantMap: !!normalized.variantMap
    });

    if (!Array.isArray(normalized.entries) || !normalized.entries.length) {
        throw new Error('預建 KANJIDIC bundle 缺少 entries');
    }

    return Promise.all([
        dbSet('dicts', 'kanjidic_data', normalized.entries),
        dbSet('dicts', 'kanji_char_reading_index', normalized.kanjiCharReadingIndex || {}),
        dbSet('dicts', 'kanji_variant_map', normalized.variantMap || {}),
        dbSet('dicts', 'kanjidic_download_time', Date.now())
    ]);
}

function rebuildStoredLexicalIndexes() {
    dictDebug('rebuildStoredLexicalIndexes:start', true);
    return Promise.all([
        dbGet('dicts', 'jmdict_data'),
        dbGet('dicts', 'kanjidic_data')
    ]).then(function(results) {
        var jmdictData = results[0];
        var kanjidicData = results[1];
        var tasks = [];

        if (Array.isArray(jmdictData) && jmdictData.length) {
            var jm = buildJMdictIndexes(jmdictData);
            tasks.push(
                dbSet('dicts', 'jmdict_expression_index', jm.expressionIndex),
                dbSet('dicts', 'jmdict_reading_index', jm.readingIndex),
                dbSet('dicts', 'jmdict_kana_normalized_index', jm.kanaNormalizedIndex),
                dbSet('dicts', 'jmdict_mixed_script_index', jm.mixedScriptIndex),
                dbSet('dicts', 'jmdict_katakana_english_index', jm.katakanaEnglishIndex)
            );
        }

        if (Array.isArray(kanjidicData) && kanjidicData.length) {
            var kj = buildKANJIDICIndexes(kanjidicData);
            tasks.push(
                dbSet('dicts', 'kanji_char_reading_index', kj.kanjiCharReadingIndex),
                dbSet('dicts', 'kanji_variant_map', kj.variantMap)
            );
        }

        return Promise.all(tasks).then(function() {
            dictDebug('rebuildStoredLexicalIndexes:done', {
                hasJMdict: !!(Array.isArray(jmdictData) && jmdictData.length),
                hasKANJIDIC: !!(Array.isArray(kanjidicData) && kanjidicData.length)
            });
            return {
                hasJMdict: !!(Array.isArray(jmdictData) && jmdictData.length),
                hasKANJIDIC: !!(Array.isArray(kanjidicData) && kanjidicData.length)
            };
        });
    });
}

function finalizeUpdateAllDictsUI(btn, ctx, ok, message) {
    if (ok) {
        btn.textContent = message || '更新完成 ✓';
    } else {
        btn.textContent = message || '更新失敗';
    }

    if (ctx && typeof ctx.renderKuromojiItems === 'function') ctx.renderKuromojiItems();
    if (ctx && typeof ctx.renderJMdictItems === 'function') ctx.renderJMdictItems();
    if (ctx && ctx.currentSelection && ctx.currentSelection.type === 'external' && typeof ctx.setActiveExternalDict === 'function') {
        ctx.setActiveExternalDict(ctx.currentSelection.key);
    }

    setTimeout(function() {
        btn.textContent = 'Update Dict';
        btn.disabled = false;
    }, ok ? 1200 : 1800);
}

function updateAllDictsRewrittenSafe(btn, ctx) {
    btn.disabled = true;
    btn.textContent = '更新中...';
    dictDebug('updateAllDictsRewrittenSafe:start', {
        disableRuntimeJMdictZip: DISABLE_RUNTIME_JMDICT_ZIP_PARSE,
        disableRuntimeKANJIDICZip: DISABLE_RUNTIME_KANJIDIC_ZIP_PARSE,
        hasPrebuiltJMdictUrl: !!PREBUILT_JMDICT_BUNDLE_URL,
        hasPrebuiltKANJIDICUrl: !!PREBUILT_KANJIDIC_BUNDLE_URL
    });

    opLog('Update Dict 安全模式開始', {
        mode: 'prebuilt_or_rebuild_only',
        disableRuntimeJMdictZip: DISABLE_RUNTIME_JMDICT_ZIP_PARSE,
        disableRuntimeKANJIDICZip: DISABLE_RUNTIME_KANJIDIC_ZIP_PARSE
    });

    return rebuildStoredLexicalIndexes().then(function() {
        return Promise.all([
            dbGet('dicts', 'jmdict_data'),
            dbGet('dicts', 'kanjidic_data')
        ]);
    }).then(function(results) {
        var jmdictData = results[0];
        var kanjidicData = results[1];
        var chain = Promise.resolve();

        if ((!Array.isArray(jmdictData) || !jmdictData.length)) {
            if (PREBUILT_JMDICT_BUNDLE_URL) {
                chain = chain.then(function() {
                    dictDebug('updateAllDictsRewrittenSafe:jmdict:prebuilt_download', PREBUILT_JMDICT_BUNDLE_URL);
                    return downloadJsonBundle(PREBUILT_JMDICT_BUNDLE_URL).then(savePrebuiltJMdictBundle);
                });
            } else if (DISABLE_RUNTIME_JMDICT_ZIP_PARSE) {
                dictDebug('updateAllDictsRewrittenSafe:jmdict:runtime_disabled_without_prebuilt', true);
                throw new Error('JMdict 自動安裝來源不可用');
            }
        }

        if ((!Array.isArray(kanjidicData) || !kanjidicData.length)) {
            if (PREBUILT_KANJIDIC_BUNDLE_URL) {
                chain = chain.then(function() {
                    dictDebug('updateAllDictsRewrittenSafe:kanjidic:prebuilt_download', PREBUILT_KANJIDIC_BUNDLE_URL);
                    return downloadJsonBundle(PREBUILT_KANJIDIC_BUNDLE_URL).then(savePrebuiltKANJIDICBundle);
                });
            } else if (DISABLE_RUNTIME_KANJIDIC_ZIP_PARSE) {
                dictDebug('updateAllDictsRewrittenSafe:kanjidic:missing_prebuilt', true);
            }
        }

        return chain;
    }).then(function() {
        return rebuildStoredLexicalIndexes();
    }).then(function() {
        finalizeUpdateAllDictsUI(btn, ctx, true, '更新完成 ✓');
        opLog('Update Dict 安全模式完成', { ok: true });
    }).catch(function(err) {
        dictDebug('updateAllDictsRewrittenSafe:error', err && (err.stack || err.message || String(err)));
        errorLog('DictManager', 'Update Dict 安全模式失敗', err && (err.message || String(err)));
        finalizeUpdateAllDictsUI(btn, ctx, false, '缺少預建字典');
    });
}

function updateAllDictsRewritten(btn, ctx) {
    dictDebug('updateAllDictsRewritten:use_runtime_mode', true);

    btn.disabled = true;
    btn.textContent = '更新中...';
    dictDebug('updateAllDictsRewritten:start', { text: btn.textContent });

    function checkKuromojiVersion() {
        dictDebug('checkKuromojiVersion:start', true);
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.github.com/repos/takuyaa/kuromoji.js/commits?path=dict&per_page=1',
                headers: { 'Accept': 'application/vnd.github.v3+json' },
                onload: function(resp) {
                    if (resp.status < 200 || resp.status >= 300) { resolve(null); return; }
                    try {
                        var commits = JSON.parse(resp.responseText);
                        resolve(commits && commits.length ? new Date(commits[0].commit.committer.date).getTime() : null);
                    } catch (e) {
                        resolve(null);
                    }
                },
                onerror: function() { resolve(null); }
            });
        });
    }

    function checkSharedYomitanVersion() {
        dictDebug('checkSharedYomitanVersion:start', true);
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
                    } catch (e) {
                        resolve(null);
                    }
                },
                onerror: function() { resolve(null); }
            });
        });
    }

    function downloadBinary(url) {
        dictDebug('downloadBinary:start', url);
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                anonymous: true,
                redirect: 'follow',
                onload: function(resp) {
                    dictDebug('downloadBinary:onload', {
                    url: url,
                    status: resp.status,
                    size: resp.response && typeof resp.response.byteLength === 'number' ? resp.response.byteLength : null
                });
                    if (resp.status >= 200 && resp.status < 300) resolve(resp.response);
                    else reject(new Error('HTTP ' + resp.status + ' ' + url));
                },
                onerror: function(err) {
                    dictDebug('downloadBinary:onerror', { url: url, error: err && (err.error || err.message || err) });
                    reject(new Error((err && err.error) || '下載失敗: ' + url));
                },
                ontimeout: function() {
                    dictDebug('downloadBinary:ontimeout', { url: url });
                    reject(new Error('下載超時: ' + url));
                }
            });
        });
    }

    function downloadKuromojiFile(fileName) {
        return downloadBinary(KUROMOJI_DICT_CDN + fileName);
    }

    opLog('Update Dict 開始', { target: 'Kuromoji + JMdict + KANJIDIC' });
    dictDebug('updateAllDictsRewritten:version_check:begin', true);

    Promise.all([
        dbGet('dicts', 'kuromoji_download_time'),
        dbGet('dicts', 'jmdict_download_time'),
        dbGet('dicts', 'kanjidic_download_time'),
        checkKuromojiVersion(),
        checkSharedYomitanVersion()
    ]).then(function(results) {
        var kuromojiLocalTime = results[0];
        var jmdictLocalTime = results[1];
        var kanjidicLocalTime = results[2];
        var kuromojiRemoteTime = results[3];
        var sharedRemoteTime = results[4];

        var needKuromoji = !kuromojiLocalTime || (kuromojiRemoteTime && kuromojiRemoteTime > kuromojiLocalTime);
        var needJMdict = !jmdictLocalTime || (sharedRemoteTime && sharedRemoteTime > jmdictLocalTime);
        var needKANJIDIC = !kanjidicLocalTime || (sharedRemoteTime && sharedRemoteTime > kanjidicLocalTime);
        dictDebug('updateAllDictsRewritten:version_check:result', {
            kuromojiLocalTime: kuromojiLocalTime,
            jmdictLocalTime: jmdictLocalTime,
            kanjidicLocalTime: kanjidicLocalTime,
            kuromojiRemoteTime: kuromojiRemoteTime,
            sharedRemoteTime: sharedRemoteTime,
            needKuromoji: needKuromoji,
            needJMdict: needJMdict,
            needKANJIDIC: needKANJIDIC
        });

        var chain = Promise.resolve();

        if (needKuromoji) {
            dictDebug('updateAllDictsRewritten:kuromoji:begin', KUROMOJI_DICT_FILES);
            chain = chain.then(function() {
                return KUROMOJI_DICT_FILES.reduce(function(fileChain, fileName) {
                    return fileChain.then(function() {
                        return downloadKuromojiFile(fileName).then(function(buffer) {
                            return dbSet('dicts', fileName, buffer);
                        });
                    });
                }, Promise.resolve()).then(function() {
                    return dbSet('dicts', 'kuromoji_download_time', Date.now());
                });
            });
        }

        if (needJMdict) {
            dictDebug('updateAllDictsRewritten:jmdict:begin', JMDICT_ZIP_URL);
            chain = chain.then(function() {
                return downloadBinary(JMDICT_ZIP_URL);
            }).then(function(buffer) {
                dictDebug('updateAllDictsRewritten:jmdict:download:done', {
                    size: buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : null
                });
                return parseJMdictArchive(buffer);
            }).then(function(entries) {
                dictDebug('updateAllDictsRewritten:jmdict:build_indexes:begin', {
                    entryCount: Array.isArray(entries) ? entries.length : 0
                });
                var indexes = buildJMdictIndexes(entries);
                dictDebug('updateAllDictsRewritten:jmdict:build_indexes:done', {
                    expressionKeys: indexes && indexes.expressionIndex ? Object.keys(indexes.expressionIndex).length : 0,
                    readingKeys: indexes && indexes.readingIndex ? Object.keys(indexes.readingIndex).length : 0,
                    kanaNormalizedKeys: indexes && indexes.kanaNormalizedIndex ? Object.keys(indexes.kanaNormalizedIndex).length : 0,
                    mixedScriptKeys: indexes && indexes.mixedScriptIndex ? Object.keys(indexes.mixedScriptIndex).length : 0,
                    katakanaEnglishKeys: indexes && indexes.katakanaEnglishIndex ? Object.keys(indexes.katakanaEnglishIndex).length : 0
                });
                dictDebug('updateAllDictsRewritten:jmdict:dbset:begin', {
                    jmdictEntries: Array.isArray(entries) ? entries.length : 0
                });
                return Promise.all([
                    dbSet('dicts', 'jmdict_data', entries),
                    dbSet('dicts', 'jmdict_expression_index', indexes.expressionIndex),
                    dbSet('dicts', 'jmdict_reading_index', indexes.readingIndex),
                    dbSet('dicts', 'jmdict_kana_normalized_index', indexes.kanaNormalizedIndex),
                    dbSet('dicts', 'jmdict_mixed_script_index', indexes.mixedScriptIndex),
                    dbSet('dicts', 'jmdict_katakana_english_index', indexes.katakanaEnglishIndex),
                    dbSet('dicts', 'jmdict_download_time', Date.now())
                ]).then(function(result) {
                    dictDebug('updateAllDictsRewritten:jmdict:dbset:done', {
                        jmdictEntries: Array.isArray(entries) ? entries.length : 0
                    });
                    return result;
                });
            });
        }

        if (needKANJIDIC) {
            dictDebug('updateAllDictsRewritten:kanjidic:begin', KANJIDIC_ZIP_URL);
            chain = chain.then(function() {
                return downloadBinary(KANJIDIC_ZIP_URL);
            }).then(function(buffer) {
                dictDebug('updateAllDictsRewritten:kanjidic:download:done', {
                    size: buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : null
                });
                return parseKANJIDICArchive(buffer);
            }).then(function(entries) {
                var indexes = buildKANJIDICIndexes(entries);
                return Promise.all([
                    dbSet('dicts', 'kanjidic_data', entries),
                    dbSet('dicts', 'kanji_char_reading_index', indexes.kanjiCharReadingIndex),
                    dbSet('dicts', 'kanji_variant_map', indexes.variantMap),
                    dbSet('dicts', 'kanjidic_download_time', Date.now())
                ]);
            });
        }

        return chain;
    }).then(function() {
        btn.textContent = '更新完成 ✓';
        if (ctx && typeof ctx.renderKuromojiItems === 'function') ctx.renderKuromojiItems();
        if (ctx && typeof ctx.renderJMdictItems === 'function') ctx.renderJMdictItems();
        if (ctx && ctx.currentSelection && ctx.currentSelection.type === 'external' && typeof ctx.setActiveExternalDict === 'function') {
            ctx.setActiveExternalDict(ctx.currentSelection.key);
        }
        opLog('Update Dict 完成', { kuromoji: true, jmdict: true, kanjidic: true });
        setTimeout(function() {
            btn.textContent = 'Update Dict';
            btn.disabled = false;
        }, 1200);
    }).catch(function(err) {
        dictDebug('updateAllDictsRewritten:catch', err && (err.stack || err.message || String(err)));
        errorLog('DictManager', 'Update Dict 失敗', err && (err.message || String(err)));
        btn.textContent = '更新失敗';
        setTimeout(function() {
            btn.textContent = 'Update Dict';
            btn.disabled = false;
        }, 1500);
    });
}

function preprocessLoanwords(text) {
    return preprocessText(text);
    var dicts = getUserDictsRaw();
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
    return kanaToRomajiCore(kana);
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
        if (kana[i] === 'ー') {
            if (result.length > 0) {
                var lastVowel = result[result.length - 1];
                var vowelMap = { 'a': 'a', 'i': 'i', 'u': 'u', 'e': 'e', 'o': 'u' };
                result += (vowelMap[lastVowel] || lastVowel);
            }
            i++;
            continue;
        }
        var two = kana.substring(i, i + 2);
        if (map[two]) {
            result += map[two];
            i += 2;
            continue;
        }
        var one = kana[i];
        if (map[one]) {
            result += map[one];
            i++;
            continue;
        }
        result += one;
        i++;
    }
    return result;
}

function processTokens(tokens) {
    return processTokensRewritten(tokens);
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

            if (pos === '記号' && pos_detail_1 === '空白') {
                result.push(' ');
                i++;
                continue;
            }

            if (pos === '記号') {
                result.push(surface);
                i++;
                continue;
            }

            if (/^[A-Za-z0-9]+$/.test(surface)) {
                if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                result.push(surface);
                i++;
                continue;
            }

            if (pos === '助詞') {
                var particleRomaji = PARTICLES[surface] || kanaToRomaji(reading).toLowerCase();
                if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                result.push(particleRomaji);
                result.push(' ');
                i++;
                continue;
            }

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

            if (pos === '助動詞' || pos_detail_1 === '接尾') {
                var auxRomaji = kanaToRomaji(reading);
                while (result.length > 0 && result[result.length - 1] === ' ') result.pop();
                result.push(auxRomaji);
                i++;
                continue;
            }

            if (isNounToken(token)) {
                var merged = greedyMerge(tokens, i, index);
                if (merged) {
                    if (result.length > 0 && result[result.length - 1] !== ' ') result.push(' ');
                    var cap = merged.romaji.charAt(0).toUpperCase() + merged.romaji.slice(1);
                    result.push(cap);
                    i += merged.count;
                    continue;
                }
            }

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
    return applyRomajiRulesRewritten(romaji);
    var macronMap = { 'ā': 'aa', 'ē': 'ee', 'ī': 'ii', 'ō': 'ou', 'ū': 'uu',
                      'Ā': 'Aa', 'Ē': 'Ee', 'Ī': 'Ii', 'Ō': 'Ou', 'Ū': 'Uu' };
    romaji = romaji.replace(/[āēīōūĀĒĪŌŪ]/g, function(c) { return macronMap[c] || c; });

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

    romaji = romaji.replace(/\s*x\s*/g, ' x ');
    romaji = romaji.replace(/\s*&\s*/g, ' & ');

    romaji = romaji.replace(/(^|\s)wo(\s|$)/g, '$1o$2');
    romaji = romaji.replace(/(^|\s)he(\s|$)/g, '$1e$2');
    romaji = romaji.replace(/(^|\s)ha(\s|$)/g, '$1wa$2');

    var particles = ['no', 'ga', 'ni', 'wo', 'o', 'wa', 'e', 'de', 'to', 'mo',
                     'ka', 'ya', 'na', 'kara', 'made', 'yori', 'demo', 'nomi',
                     'dake', 'shika', 'sae', 'mo', 'desu', 'masu', 'da', 'ne', 'yo'];
    particles.forEach(function(p) {
        var re = new RegExp('(\\s)' + p + '(\\s|$)', 'g');
        romaji = romaji.replace(re, function(match, pre, post) {
            return pre + p + post;
        });
    });

    romaji = romaji.replace(/tch/gi, 'cch');
    romaji = romaji.replace(/xtsu([!?.）)~])/gi, '$1');
    romaji = romaji.replace(/ltu([!?.）)~])/gi, '$1');

    HONORIFICS.forEach(function(h) {
        var re = new RegExp('([a-zA-Z])\\s+(' + h + ')(?=\\s|$|[^a-zA-Z])', 'gi');
        romaji = romaji.replace(re, function(match, prev, honorific) {
            return prev + '-' + honorific.toLowerCase();
        });
    });

    romaji = romaji.replace(/(\w+)\s+hon\b/gi, function(match, prev) {
        return prev + ' Bon';
    });

    romaji = romaji.replace(/(\d{4})\s*nen\s*(\d{1,2})\s*gatsu\s*(?:gou|go|号)?/gi, function(match, year, month) {
        return year + '-' + ('0' + month).slice(-2);
    });

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
            return seg.text.replace(/\(([a-z])/g, function(m, c) { return '(' + c.toUpperCase(); })
                           .replace(/\[([a-z])/g, function(m, c) { return '[' + c.toUpperCase(); });
        }
        return seg.text.replace(/(?:^|(?<=\s))([a-zA-Z]+)/g, function(word) {
            var lower = word.toLowerCase();
            if (word === word.toUpperCase() && word.length > 1 && /^[A-Z]+$/.test(word)) {
                return word;
            }
            if (particleSet[lower]) {
                return lower;
            }
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        });
    }).join('');

    romaji = romaji.replace(/^([a-z])/, function(c) { return c.toUpperCase(); });
    romaji = romaji.replace(/\s+/g, ' ').trim();
    romaji = romaji.replace(/\s+\)/g, ')');
    romaji = romaji.replace(/\(\s+/g, '(');
    romaji = romaji.replace(/\)\s+\(/g, ') (');

    return romaji;
}

function convertToRomaji(text, romanBtn, outputField) {
    if (!text || !text.trim()) {
        warnLog('Romanization', '輸入文字為空');
        return;
    }

    return convertToRomajiRewritten(text, romanBtn, outputField);

    romanBtn.disabled = true;
    _debug('[DIAG] === 分詞診斷 ===');
    _debug('[DIAG] 輸入文字:', text);

    preprocessLoanwords(text).then(function(preprocessed) {
        _debug('[DIAG] preprocessLoanwords 輸出:', preprocessed);
        _debug('[DIAG] user_dicts:', JSON.stringify(getUserDictsRaw()));
    });

    romanBtn.textContent = '初始化中...';

    preprocessLoanwords(text).then(function(preprocessed) {
        flowLog('Romanization', '預處理完成', preprocessed);
        return initKuroshiro().then(function(success) {
            if (!success && !_kuroshiroReady) {
                errorLog('Romanization', 'Kuroshiro 初始化失敗');
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
                flowLog('Romanization', '分詞完成', { count: tokens.length });
                processTokens(tokens).then(function(result) {
                    result = applyRomajiRules(result);
                    opLog('羅馬字轉換', { input: text, output: result });
                    outputField.value = result;
                    romanBtn.disabled = false;
                    romanBtn.textContent = 'Romanization';
                }).catch(function(err) {
                    errorLog('Romanization', 'Token 轉換失敗', err.message || err);
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
                errorLog('Romanization', '分詞失敗', err.message || err);
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
        errorLog('Romanization', '預處理失敗', err.message || err);
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
        Array.from(langSelect.options).forEach(function(opt) {
            if (opt.value === savedData.language) opt.selected = true;
        });
    }
    td1_4.appendChild(langSelect);

    var td1_5 = document.createElement('td');
    td1_5.className = 'gtc4';
    td1_5.style.cssText = 'text-align: left !important; padding-left: 2px !important;';
    var folderSelect = createFolderSelect();
    if (savedData && savedData.folder) {
        Array.from(folderSelect.options).forEach(function(opt) {
            if (opt.value === savedData.folder) opt.selected = true;
        });
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
    tplRow.style.cssText = 'display: flex; justify-content: flex-start; align-items: center; gap: 4px; margin-top: 2px; width: 100%; box-sizing: border-box; padding-right: 4px;';

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

    getCommentTemplatesSafe().forEach(function(tpl) {
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
        var templates = getCommentTemplatesSafe();
        var found = templates.find(function(t) { return t.id === tplSelect.value; });
        if (found) {
            uploaderCommentTA.value = found.content;
            uploaderCommentTA.style.height = 'auto';
            uploaderCommentTA.style.height = uploaderCommentTA.scrollHeight + 'px';
        }
    });
    tplRow.appendChild(tplGoBtn);

    var tplSpacer = document.createElement('div');
    tplSpacer.style.cssText = 'flex: 1;';
    tplRow.appendChild(tplSpacer);

    var romanBtn = document.createElement('button');
    romanBtn.textContent = 'Romanization';
    romanBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 0 6px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 18px; line-height: 16px; box-sizing: border-box; flex-shrink: 0;';
    romanBtn.addEventListener('click', function(e) {
        e.preventDefault();
        runGalleryGroupRomanization(getGalleryGroupFields([tr1, tr2]));
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
    swapBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var tmp = inputTitle.value;
        inputTitle.value = inputTitle2.value;
        inputTitle2.value = tmp;
    });
    td2_2.appendChild(swapBtn);

    var savedDataId = (savedData && savedData.id && savedData.id !== 'undefined') ? savedData.id : null;
    if (savedDataId) tr2.dataset.savedDataId = savedDataId;

    var zipBtn = document.createElement('button');
    zipBtn.textContent = 'ZIP';
    zipBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: pointer; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 2px 0 0 0; white-space: nowrap; width: 26px;';
    zipBtn.addEventListener('click', function(e) {
        e.preventDefault();
        archiveStatusBtn.textContent = '';
        archiveStatusBtn.title = '';
        archiveStatusBtn.style.backgroundColor = '#E0DED3';
        archiveStatusBtn.style.color = '#5C0D12';

        selectAuthorizedArchiveFilesWithPicker().then(function(selection) {
            var files = selection.files || [];
            if (!files.length) return;

            flowLog('ZIP', '開始處理壓縮檔', files.map(function(file) {
                return file.name;
            }).join(', '));

            var confirmColorMs = currentSettings.confirmBtnColorMs || 1000;

            handleArchiveFiles(files, archiveStatusBtn, function(results) {
                if (results.length === 0) return;
                var allFiles = [];
                var rootSources = [];
                results.forEach(function(r) {
                    var rootName = getArchiveSourceLabelFromResult(r);
                    rootSources.push({ name: rootName, type: 'archive' });
                    allFiles = allFiles.concat(createGallerySourcePrefixedFileEntries(r.files, rootName));
                });
                allFiles.sort(function(a, b) { return naturalCompare(a.path, b.path); });

                if (allFiles.length > MAX_FILES) {
                    warnLog('ZIP', '文件數超過限制，截斷', { limit: MAX_FILES, original: allFiles.length });
                    allFiles = allFiles.slice(0, MAX_FILES);
                }

                opLog('解壓完成', { count: allFiles.length, source: 'ZIP' });
                filesSpan.textContent = allFiles.length;
                requestAnimationFrame(function() { alignFilesText(filesSpan, td1_2); });

                if (savedDataId) {
                    writeGalleryFileListById(
                        savedDataId,
                        null,
                        allFiles,
                        'archive',
                        rootSources[0] ? rootSources[0].name : null,
                        rootSources,
                        null
                    );
                }
                refreshShowFileListPanelIfOpen();

                flashColoredSuccessState(archiveStatusBtn, '✓', '', confirmColorMs);
            });
        }).catch(function(err) {
            if (err && err.name === 'AbortError') {
                archiveStatusBtn.textContent = '';
                archiveStatusBtn.title = '';
                archiveStatusBtn.style.backgroundColor = '#E0DED3';
                archiveStatusBtn.style.color = '#5C0D12';
                return;
            }

            var displayMessage = getAuthorizedSelectionFailureDisplayMessage(err, '壓縮檔');
            warnLog('ZIP', displayMessage, {
                code: err && err.code,
                message: err && (err.message || err)
            });
            archiveStatusBtn.textContent = '✕';
            archiveStatusBtn.title = displayMessage;
            archiveStatusBtn.style.backgroundColor = '#CC0000';
            archiveStatusBtn.style.color = '#FFFFFF';
            setTimeout(function() {
                archiveStatusBtn.textContent = '';
                archiveStatusBtn.title = '';
                archiveStatusBtn.style.backgroundColor = '#E0DED3';
                archiveStatusBtn.style.color = '#5C0D12';
            }, 2000);
        });
    });
    td2_2.appendChild(zipBtn);

    var folderScanBtn = document.createElement('button');
    folderScanBtn.textContent = '📁';
    folderScanBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; height: 18px; line-height: 16px; cursor: pointer; border-radius: 2px; display: block; box-sizing: border-box; padding: 0 4px; margin: 2px 0 0 0; white-space: nowrap; width: 26px;';
    folderScanBtn.addEventListener('click', function(e) {
        e.preventDefault();
        flowLog('Folder', '開始掃描目錄');
        archiveStatusBtn.textContent = '';
        archiveStatusBtn.title = '';
        archiveStatusBtn.style.backgroundColor = '#E0DED3';
        archiveStatusBtn.style.color = '#5C0D12';

        selectAuthorizedDirectoryWithPicker().then(function(selection) {
            var dirHandle = selection.handle;
            var authorizedRootEntry = selection.authorizedRootEntry;
            var relativeRootPath = buildAuthorizedRelativePathFromParts(selection.relativePathParts);
            var imageFiles = [];
            var skipped = 0;
            var fileCount = 0;

            function scanDir(handle, prefix) {
                _debug('[Progress] 文件夾:', prefix || '/');
                var entries = handle.values();
                function processEntries() {
                    return entries.next().then(function(result) {
                        if (result.done) return;
                        var entry = result.value;
                        var fullPath = prefix ? prefix + '/' + entry.name : entry.name;
                        if (entry.kind === 'file') {
                            fileCount++;
                            _debug('[Progress] 文件:', fullPath);
                            var ext = entry.name.split('.').pop().toLowerCase();
                            if (ACCEPTED_FORMATS.indexOf(ext) === -1) {
                                skipped++;
                                _debug('[Folder] 過濾不支持格式:', fullPath);
                                return processEntries();
                            }
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
                    warnLog('Folder', '文件數超過限制，截斷', { limit: MAX_FILES, original: imageFiles.length });
                    imageFiles = imageFiles.slice(0, MAX_FILES);
                }

                var folderSourceLabel = relativeRootPath || dirHandle.name;
                var rootSources = [{ name: folderSourceLabel, type: 'folder' }];
                var prefixedImageFiles = createGallerySourcePrefixedFileEntries(imageFiles, relativeRootPath);

                opLog('掃描資料夾完成', {
                    folderName: folderSourceLabel,
                    authorizedRootId: authorizedRootEntry ? authorizedRootEntry.id : null,
                    validFiles: imageFiles.length,
                    skipped: skipped,
                    total: fileCount
                });
                filesSpan.textContent = imageFiles.length;
                requestAnimationFrame(function() { alignFilesText(filesSpan, td1_2); });

                if (savedDataId) {
                    writeGalleryFileListById(
                        savedDataId,
                        relativeRootPath || '',
                        prefixedImageFiles,
                        'folder',
                        folderSourceLabel,
                        rootSources,
                        authorizedRootEntry ? authorizedRootEntry.id : null
                    );
                }
                refreshShowFileListPanelIfOpen();

                var confirmColorMs = currentSettings.confirmBtnColorMs || 1000;
                if (currentSettings.confirmBtnColorChange !== false) {
                    archiveStatusBtn.textContent = '✓';
                    archiveStatusBtn.style.backgroundColor = '#00AA00';
                    archiveStatusBtn.style.color = '#FFFFFF';
                    setTimeout(function() {
                        archiveStatusBtn.textContent = '';
                        archiveStatusBtn.style.backgroundColor = '#E0DED3';
                        archiveStatusBtn.style.color = '#5C0D12';
                    }, confirmColorMs);
                } else {
                    archiveStatusBtn.textContent = '✓';
                    setTimeout(function() { archiveStatusBtn.textContent = ''; }, 1000);
                }
            });
        }).catch(function(err) {
            if (err && err.name === 'AbortError') {
                archiveStatusBtn.textContent = '';
                archiveStatusBtn.style.backgroundColor = '#E0DED3';
                archiveStatusBtn.style.color = '#5C0D12';
                return;
            }

            errorLog('Folder', 'Directory picker error', err);
            archiveStatusBtn.textContent = '✕';
            archiveStatusBtn.style.backgroundColor = '#CC0000';
            archiveStatusBtn.style.color = '#FFFFFF';
            setTimeout(function() {
                archiveStatusBtn.textContent = '';
                archiveStatusBtn.style.backgroundColor = '#E0DED3';
                archiveStatusBtn.style.color = '#5C0D12';
            }, 2000);
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
        if (savedData.options.translated) {
            cbTranslated.checkbox.checked = true;
            mtlSpan.style.display = 'inline-flex';
            if (savedData.mtl) mtlOption.checkbox.checked = true;
        }
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
    requestAnimationFrame(function() {
        requestAnimationFrame(function() {
            positionMtlSpan();
        });
    });

    cbOfficialTextless.checkbox.addEventListener('click', function() {
        if (!cbTranslated.checkbox.checked && !cbRewrite.checkbox.checked) {
            this.checked = true;
            return;
        }
        cbTranslated.checkbox.checked = false;
        cbRewrite.checkbox.checked = false;
        mtlSpan.style.display = 'none';
        mtlOption.checkbox.checked = false;
    });

    cbTranslated.checkbox.addEventListener('click', function() {
        if (!cbOfficialTextless.checkbox.checked && !cbRewrite.checkbox.checked) {
            this.checked = true;
            return;
        }
        cbOfficialTextless.checkbox.checked = false;
        cbRewrite.checkbox.checked = false;
        mtlSpan.style.display = 'inline-flex';
        if (currentSettings.translatedDefaultMTL) {
            mtlOption.checkbox.checked = true;
        }
    });

    cbRewrite.checkbox.addEventListener('click', function() {
        if (!cbOfficialTextless.checkbox.checked && !cbTranslated.checkbox.checked) {
            this.checked = true;
            return;
        }
        cbOfficialTextless.checkbox.checked = false;
        cbTranslated.checkbox.checked = false;
        mtlSpan.style.display = 'none';
        mtlOption.checkbox.checked = false;
    });

    langSelect.addEventListener('change', function() {
        handleGalleryLanguageControlChange(this);
    });

    var uploaderRow = document.createElement('div');
    uploaderRow.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; margin-top: 4px; width: 100%; box-sizing: border-box; padding-right: 4px;';

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
        var isExpanded = parseInt(uploaderCommentTA.style.height, 10) > 24;
        if (isExpanded) {
            uploaderCommentTA.style.height = '24px';
            uploaderCommentTA.style.overflowY = 'hidden';
        } else {
            uploaderCommentTA.style.height = '24px';
            uploaderCommentTA.style.height = uploaderCommentTA.scrollHeight + 'px';
            uploaderCommentTA.style.overflowY = 'auto';
            uploaderCommentTA.focus();
        }
    });
    uploaderRow.appendChild(uploaderCommentTA);

    var saveCommentBtn = document.createElement('button');
    saveCommentBtn.textContent = 'save';
    saveCommentBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 9pt; padding: 2px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap; height: 24px; line-height: 20px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0;';
    saveCommentBtn.addEventListener('click', function(e) {
        e.preventDefault();
        try {
            var galleryData = persistGalleryGroup(getGalleryGroupFields([tr1, tr2]));
            savedDataId = galleryData.id;
            flashButtonSavedState(saveCommentBtn, '已儲存 ✓', 'save', 500);
            opLog('保存畫廊', { id: galleryData.id, title: galleryData.title1 || galleryData.title2 || '' });
            refreshShowFileListPanelIfOpen();
        } catch (error) {
            errorLog('Save', '保存畫廊失敗', error);
        }
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
            var pendingData = buildPendingCreateDataFromFields(getGalleryGroupFields([tr1, tr2]));
            GM_setValue('pending_create', pendingData);
            opLog('建立單一圖庫', { title: pendingData.title1 || pendingData.title2 || '', savedDataId: pendingData.savedDataId || null });
            GM_openInTab('https://upload.e-hentai.org/managegallery?act=new', { active: false });
        } catch (err) {
            errorLog('CreateGallery', '+ 按鈕錯誤', err.message);
        }
    });
    td2_6.appendChild(plusBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.textContent = '-';
    deleteBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; width: 13px; height: 13px; line-height: 11px; cursor: pointer; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0; margin: 0 !important;';
    deleteBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        triggerDeleteBySettings(deleteBtn, function() {
            var removed = deleteGalleryGroupByFields(getGalleryGroupFields([tr1, tr2]), folderRow1, waitingCreateCountRef);
            if (!removed) return;
            refreshShowFileListPanelIfOpen();
            opLog('刪除等待建立項目', { id: savedDataId || null, title: inputTitle.value || inputTitle2.value || '' });
        });
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
        var saved = getSavedGalleriesSafe();
        if (!Array.isArray(saved) || saved.length === 0) return;

        var validSaved = saved.filter(function(g) {
            return g && g.id && g.id !== 'undefined' && g.id !== undefined;
        });
        if (validSaved.length !== saved.length) {
            saveSavedGalleriesSafe(validSaved);
        }
        if (validSaved.length === 0) return;

        var folderToggle1 = folderRow1.querySelector('.folder-toggle');
        if (folderToggle1 && folderToggle1.textContent === '[+]') {
            var nextRowCheck = folderRow1.nextElementSibling;
            while (nextRowCheck) {
                nextRowCheck.style.display = 'table-row';
                nextRowCheck = nextRowCheck.nextElementSibling;
            }
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
        flowLog('SavedGalleries', '已載入等待建立圖庫', validSaved.length);
    } catch (error) {
        errorLog('SavedGalleries', '載入保存的圖庫失敗', error);
    }
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
        if (match) {
            var base = match[1];
            if (!groups[base]) groups[base] = { type: 'zip-split', parts: [], base: base };
            groups[base].parts.push({ idx: parseInt(match[2], 10), file: file });
            return;
        }
        match = name.match(/^(.+)\.z(\d+)$/i);
        if (match) {
            var base2 = match[1];
            if (!groups[base2]) groups[base2] = { type: 'zip-z', parts: [], base: base2 };
            groups[base2].parts.push({ idx: parseInt(match[2], 10), file: file });
            return;
        }
        var ext = name.split('.').pop().toLowerCase();
        if (ext === 'zip') {
            var base3 = name.replace(/\.[^.]+$/, '');
            if (!groups[base3]) groups[base3] = { type: 'zip-single', parts: [], base: base3 };
            groups[base3].parts.push({ idx: 0, file: file });
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
    flowLog('extractArchive', '開始處理', { fileName: fileName, ext: ext });
    _debug('[extractArchive] 使用 JSZip');
    return extractWithJSZip(fileOrBuffer, onProgress);
}

function extractWithJSZip(fileOrBuffer, onProgress) {
    flowLog('JSZip', '開始載入 ZIP');
    return JSZip.loadAsync(fileOrBuffer).then(function(zip) {
        flowLog('JSZip', 'ZIP 載入成功，開始讀取文件列表');
        var imageFiles = [];
        var skipped = 0;
        var entries = [];
        zip.forEach(function(relativePath, zipEntry) {
            if (!zipEntry.dir) entries.push({ path: relativePath, entry: zipEntry });
        });
        var total = entries.length;
        var done = 0;
        flowLog('JSZip', '開始逐一處理文件', total);

        function processNext(idx) {
            if (idx >= entries.length) {
                opLog('解壓完成', { validFiles: imageFiles.length, skipped: skipped });
                return Promise.resolve({ files: imageFiles, skipped: skipped });
            }
            var item = entries[idx];
            done++;
            var ext = (item.entry.name || '').split('.').pop().toLowerCase();

            if (ext === 'zip') {
                _debug('[Progress] ' + done + '/' + total + ' [內層ZIP] ' + item.path);
                return item.entry.async('arraybuffer').then(function(buf) {
                    return extractArchive(buf, item.entry.name, onProgress);
                }).then(function(result) {
                    result.files.forEach(function(f) { imageFiles.push(f); });
                    skipped += result.skipped;
                    return processNext(idx + 1);
                }).catch(function(err) {
                    warnLog('JSZip', '內層解壓失敗', { path: item.path, error: err });
                    skipped++;
                    return processNext(idx + 1);
                });
            }

            if (!validateFile(item.entry.name, 0)) {
                skipped++;
                _debug('[Progress] ' + done + '/' + total + ' [跳過] ' + item.path);
                return processNext(idx + 1);
            }

            _debug('[Progress] ' + done + '/' + total + ' ' + item.path);
            if (onProgress) onProgress(done, total, item.path);
            imageFiles.push({ name: item.entry.name, path: item.path });
            return Promise.resolve().then(function() { return processNext(idx + 1); });
        }

        return processNext(0);
    });
}

function extractNestedArchives(files, depth, onProgress) {
    if (depth > 5) {
        warnLog('Nested', '遞迴深度超過5層，停止解壓');
        return Promise.resolve(files);
    }
    var nestedPromises = [];
    var finalFiles = [];
    files.forEach(function(file) {
        var ext = (file.name || file.path || '').split('.').pop().toLowerCase();
        if (ext === 'zip' && file.buffer) {
            flowLog('Nested', '檢測到內層壓縮檔', { path: file.path, depth: depth });
            nestedPromises.push(
                extractArchive(file.buffer, file.name, onProgress)
                    .then(function(result) {
                        if (result.files.length > 0) {
                            flowLog('Nested', '內層解壓成功', { path: file.path, count: result.files.length });
                            return extractNestedArchives(result.files, depth + 1, onProgress);
                        } else {
                            return [];
                        }
                    }).then(function(nestedFiles) {
                        finalFiles = finalFiles.concat(nestedFiles);
                    }).catch(function(err) {
                        errorLog('Nested', '解壓失敗', { path: file.path, error: err });
                        finalFiles.push(file);
                    })
            );
        } else {
            finalFiles.push(file);
        }
    });
    if (nestedPromises.length === 0) return Promise.resolve(finalFiles);
    return Promise.all(nestedPromises).then(function() {
        flowLog('Nested', '深度處理完成', { depth: depth, finalCount: finalFiles.length });
        return finalFiles;
    });
}

function handleArchiveFiles(droppedFiles, statusBtn, onComplete) {
    var groups = identifyVolumeParts(droppedFiles);
    var keys = Object.keys(groups);
    if (keys.length === 0) {
        warnLog('Archive', '無可識別的壓縮檔');
        if (statusBtn) {
            statusBtn.textContent = '✕';
            statusBtn.style.backgroundColor = '#CC0000';
            statusBtn.style.color = '#FFFFFF';
            setTimeout(function() {
                statusBtn.textContent = '';
                statusBtn.style.backgroundColor = '#E0DED3';
                statusBtn.style.color = '#5C0D12';
            }, 2000);
        }
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
            flowLog('Archive', '處理單檔壓縮包', file.name);
            if (statusBtn) {
                statusBtn.textContent = '...';
                statusBtn.style.backgroundColor = '#E0DED3';
            }
            extractArchive(file, file.name, function(done, total, name) {
                _debug('[Progress] ' + done + '/' + total + ' ' + name);
            }).then(function(result) {
                result.title = group.base;
                results.push(result);
                processNext();
            }).catch(function(err) {
                errorLog('Archive', '解壓失敗', err);
                if (statusBtn) {
                    statusBtn.textContent = '✕';
                    statusBtn.style.backgroundColor = '#CC0000';
                    statusBtn.style.color = '#FFFFFF';
                    setTimeout(function() {
                        statusBtn.textContent = '';
                        statusBtn.style.backgroundColor = '#E0DED3';
                        statusBtn.style.color = '#5C0D12';
                    }, 2000);
                }
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
                flowLog('Archive', '分卷完整，開始合併', key);
                if (statusBtn) {
                    statusBtn.textContent = '...';
                    statusBtn.style.backgroundColor = '#E0DED3';
                }
                mergeVolumeParts(_pendingVolumes[key]).then(function(merged) {
                    return extractWithJSZip(merged, function(done, total, name) {
                        _debug('[Progress] ' + done + '/' + total + ' ' + name);
                    });
                }).then(function(result) {
                    result.title = _pendingVolumes[key].base;
                    results.push(result);
                    delete _pendingVolumes[key];
                    delete _volumeTimers[key];
                    processNext();
                }).catch(function(err) {
                    errorLog('Archive', '分卷解壓失敗', err);
                    if (statusBtn) {
                        statusBtn.textContent = '✕';
                        statusBtn.style.backgroundColor = '#CC0000';
                        statusBtn.style.color = '#FFFFFF';
                        setTimeout(function() {
                            statusBtn.textContent = '';
                            statusBtn.style.backgroundColor = '#E0DED3';
                            statusBtn.style.color = '#5C0D12';
                        }, 2000);
                    }
                    delete _pendingVolumes[key];
                    delete _volumeTimers[key];
                    processNext();
                });
            } else {
                flowLog('Archive', '分卷不完整，等待更多部分', { key: key, count: _pendingVolumes[key].parts.length });
                if (statusBtn) {
                    statusBtn.textContent = '⏳';
                    statusBtn.style.backgroundColor = '#CCAA00';
                    statusBtn.style.color = '#FFFFFF';
                }
                _volumeTimers[key] = setTimeout(function() {
                    warnLog('Archive', '分卷等待超時(60秒)，請重新讀取', key);
                    if (statusBtn) {
                        statusBtn.textContent = '✕';
                        statusBtn.style.backgroundColor = '#CC0000';
                        statusBtn.style.color = '#FFFFFF';
                        setTimeout(function() {
                            statusBtn.textContent = '';
                            statusBtn.style.backgroundColor = '#E0DED3';
                            statusBtn.style.color = '#5C0D12';
                        }, 2000);
                    }
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
    title.textContent = 'Dict Manager';
    title.style.cssText = 'height: 26px; min-height: 26px; display: inline-flex; align-items: center; font-weight: bold; font-size: 10pt; color: #5C0D12; flex-shrink: 0; white-space: nowrap; box-sizing: border-box; margin: 0; line-height: 1;';

    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px; min-height: 26px;';

    var titleRight = document.createElement('div');
    titleRight.style.cssText = 'display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex: 1; min-width: 0; min-height: 26px;';

    var localDictSelect = document.createElement('select');
    applyTopBarControlStyle(localDictSelect, '150px', 'min-width: 150px;color: #5C0D12;');

    var priorityPadLabel = document.createElement('span');
    priorityPadLabel.textContent = '優先度固定補零長度:';
    priorityPadLabel.style.cssText = 'font-size: 9pt; color: #5C0D12; white-space: nowrap; display: none;';

    var priorityPadInput = document.createElement('input');
    priorityPadInput.type = 'text';
    priorityPadInput.value = String(getDictPriorityPadLengthSafe());
    applyTopBarControlStyle(priorityPadInput, '48px', 'text-align: center;color: #333;display: none;');

    function applyPriorityPadLengthFromInput() {
        var raw = String(priorityPadInput.value || '').trim();
        var parsed = /^[1-9]\d*$/.test(raw) ? parseInt(raw, 10) : 5;
        parsed = saveDictPriorityPadLengthSetting(parsed);
        priorityPadInput.value = String(parsed);
        if (currentSelection.type === 'local' && currentSelection.key) {
            renderLocalDictPanel(currentSelection.key, currentSelection.key);
        }
    }

    priorityPadInput.addEventListener('change', applyPriorityPadLengthFromInput);
    priorityPadInput.addEventListener('blur', applyPriorityPadLengthFromInput);

    var topKeyInput = document.createElement('input');
    topKeyInput.type = 'text';
    topKeyInput.placeholder = '原文';
    applyTopBarControlStyle(topKeyInput, '150px', 'min-width: 120px;color: #333;');

    var topValInput = document.createElement('input');
    topValInput.type = 'text';
    topValInput.placeholder = '羅馬音(替換值)';
    applyTopBarControlStyle(topValInput, '180px', 'min-width: 140px;color: #333;');

    var topSaveBtn = document.createElement('button');
    topSaveBtn.textContent = 'Save';
    applyPageToneBtnStyle(topSaveBtn, 'height: 26px;min-width: 56px;padding: 0 10px;background: #E0DED3;color: #5C0D12;border: 1px solid #5C0D12;');

    var updateDictBtn = document.createElement('button');
    updateDictBtn.textContent = 'Update Dict';
    applyPageToneBtnStyle(updateDictBtn, 'height: 26px;min-width: 88px;padding: 0 10px;background: #E0DED3;color: #5C0D12;border: 1px solid #5C0D12;');

    titleRight.appendChild(localDictSelect);
    titleRight.appendChild(priorityPadLabel);
    titleRight.appendChild(priorityPadInput);
    titleRight.appendChild(topKeyInput);
    titleRight.appendChild(topValInput);
    titleRight.appendChild(topSaveBtn);
    titleRight.appendChild(updateDictBtn);

    titleRow.appendChild(title);
    titleRow.appendChild(titleRight);
    container.appendChild(titleRow);

    var body = document.createElement('div');
    body.style.cssText = 'display: flex; gap: 0; min-height: 300px;';

    var leftCol = document.createElement('div');
    leftCol.style.cssText = 'width: 180px; flex-shrink: 0; display: flex; flex-direction: column; border: 1px solid #5C0D12; background: #E0DED3;';

    var navList = document.createElement('div');
    navList.style.cssText = 'flex: 1; overflow-y: auto;';

    var leftBottomBar = document.createElement('div');
    leftBottomBar.style.cssText = 'display: flex; gap: 4px; padding: 4px; border-top: 1px solid #5C0D12; background: #E0DED3;';

    var addLocalDictBtn = document.createElement('button');
    addLocalDictBtn.textContent = '新增';
    applyPageToneBtnStyle(addLocalDictBtn, 'flex: 1;height: 24px;');

    var renameLocalDictBtn = document.createElement('button');
    renameLocalDictBtn.textContent = '更名';
    applyPageToneBtnStyle(renameLocalDictBtn, 'flex: 1;height: 24px;');

    var deleteLocalDictBtn = document.createElement('button');
    deleteLocalDictBtn.textContent = '刪除';
    applyPageToneBtnStyle(deleteLocalDictBtn, 'flex: 1;height: 24px;');

    leftBottomBar.appendChild(addLocalDictBtn);
    leftBottomBar.appendChild(renameLocalDictBtn);
    leftBottomBar.appendChild(deleteLocalDictBtn);

    var rightCol = document.createElement('div');
    rightCol.style.cssText = 'flex: 1; border: 1px solid #5C0D12; border-left: none; background: transparent; display: flex; flex-direction: column; min-width: 0;';

    body.appendChild(leftCol);
    body.appendChild(rightCol);
    container.appendChild(body);

    var groupStates = { local: false, external: false, kuromoji: false, jmdict: false };
    var kuromojiItemsDiv = document.createElement('div');
    var jmdictItemsDiv = document.createElement('div');
    var currentSelection = { type: null, key: null, elementKey: null };
    var editingRowsStateMap = {};
    var rightListDiv = null;
    var rightBottomRow = null;
    var modalOverlay = null;
    var localDictCache = {};
    var currentLocalDict = null;

    function formatReadableSize(val) {
        if (val === null || val === undefined) return 'N/A';
        var size = null;
        if (typeof val.byteLength === 'number') size = val.byteLength;
        else if (typeof val.size === 'number') size = val.size;
        if (size === null || isNaN(size)) return 'N/A';
        if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
        if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
        return size + ' B';
    }

    function getDictPriorityPadLengthSafe() {
        var settings = getCurrentSettingsSafe();
        var value = parseInt(settings && settings.dictPriorityPadLength, 10);
        if (!isFinite(value) || value < 1) value = 5;
        return value;
    }

    function saveDictPriorityPadLengthSetting(value) {
        value = parseInt(String(value || '').trim(), 10);
        if (!isFinite(value) || value < 1) value = 5;
        var settings = Object.assign({}, getCurrentSettingsSafe(), {
            dictPriorityPadLength: value
        });
        saveSettings(settings);
        return value;
    }

    function formatPriorityDisplay(priority) {
        priority = parseInt(priority, 10);
        if (!isFinite(priority) || priority < 1) priority = 1;
        return String(priority).padStart(getDictPriorityPadLengthSafe(), '0');
    }

    function moveRowToPriorityPosition(rows, row, priority) {
        var fromIndex = rows.indexOf(row);
        if (fromIndex < 0) return;

        priority = parseInt(String(priority || '').trim(), 10);
        if (!isFinite(priority) || priority < 1) priority = 1;
        if (priority > rows.length) priority = rows.length;

        var targetIndex = priority - 1;
        if (targetIndex === fromIndex) return;

        rows.splice(fromIndex, 1);
        rows.splice(targetIndex, 0, row);
    }

    function rebuildLocalDictObjectFromRows(rows, includeAllEdits) {
        var rebuilt = {};
        rows.forEach(function(row) {
            var useEdit = !!(row && row.editing && (includeAllEdits || row.checked));
            var nextKey = String((useEdit ? row.editKey : row.key) || '').trim();
            var nextVal = String((useEdit ? row.editVal : row.val) || '');
            if (!nextKey) return;

            rebuilt[nextKey] = nextVal;
            row.key = nextKey;
            row.val = nextVal;
            row.editKey = nextKey;
            row.editVal = nextVal;
            if (useEdit) row.editing = false;
            row.checked = false;
        });
        return rebuilt;
    }

    function saveAllLocalDictRows(dictKey, rows) {
        var dicts = getUserDictsRaw();
        dicts[dictKey] = rebuildLocalDictObjectFromRows(rows, true);
        setUserDictsRaw(dicts);
        localDictCache[dictKey] = null;
    }

    function showPriorityEditModal(rows, row, onDone) {
        if (modalOverlay) modalOverlay.remove();

        modalOverlay = document.createElement('div');
        modalOverlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 999999; display: flex; align-items: center; justify-content: center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'width: 360px; max-width: calc(100vw - 24px); background: #E0DED3; border: 1px solid #5C0D12; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); padding: 12px; box-sizing: border-box;';

        var titleEl = document.createElement('div');
        titleEl.textContent = '修改優先度';
        titleEl.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 8px;';

        var input = document.createElement('input');
        input.type = 'text';
        input.value = String(rows.indexOf(row) + 1);
        input.placeholder = '請輸入正整數';
        input.style.cssText = 'width: 100%; height: 26px; border: 1px solid #5C0D12; border-radius: 3px; background: #FAFAFA; color: #333; font-size: 9pt; padding: 0 8px; box-sizing: border-box; outline: none;';

        var hint = document.createElement('div');
        hint.textContent = 'Enter 確認，Esc 取消';
        hint.style.cssText = 'font-size: 8.5pt; color: #555; margin-top: 6px;';

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px;';

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        applyPageToneBtnStyle(cancelBtn, 'height: 24px;min-width: 64px;background: #FAFAFA;');

        var okBtn = document.createElement('button');
        okBtn.textContent = '修改';
        applyPrimaryDarkBtnStyle(okBtn, 'height: 24px;min-width: 64px;');

        function closeModal() {
            document.removeEventListener('keydown', onKeyDown, true);
            if (modalOverlay) modalOverlay.remove();
            modalOverlay = null;
        }

        function showInvalidState() {
            var delayMs = getCurrentSettingsSafe().confirmBtnColorMs || 1000;
            okBtn.style.backgroundColor = '#CC0000';
            okBtn.style.borderColor = '#CC0000';
            okBtn.style.color = '#FFFFFF';
            setTimeout(function() {
                okBtn.style.backgroundColor = '#5C0D12';
                okBtn.style.borderColor = '#5C0D12';
                okBtn.style.color = '#FFFFFF';
            }, delayMs);
        }

        function submit() {
            var raw = String(input.value || '').trim();
            if (!/^[1-9]\d*$/.test(raw)) {
                showInvalidState();
                input.focus();
                input.select();
                return;
            }

            moveRowToPriorityPosition(rows, row, parseInt(raw, 10));
            closeModal();
            if (typeof onDone === 'function') onDone();
        }

        function onKeyDown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeModal();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
        }

        cancelBtn.addEventListener('click', function(e) {
            e.preventDefault();
            closeModal();
        });

        okBtn.addEventListener('click', function(e) {
            e.preventDefault();
            submit();
        });

        modalOverlay.addEventListener('click', function(e) {
            if (e.target === modalOverlay) closeModal();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        modal.appendChild(titleEl);
        modal.appendChild(input);
        modal.appendChild(hint);
        modal.appendChild(btnRow);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        document.addEventListener('keydown', onKeyDown, true);
        setTimeout(function() {
            input.focus();
            input.select();
        }, 0);
    }

    if (typeof _emitBrowserConsole === 'function' && !_emitBrowserConsole.__debugFilterWrapped) {
    var _emitBrowserConsole__originalForDebugFilter = _emitBrowserConsole;
    var _emitBrowserConsole__wrappedForDebugFilter = function(level, args) {
        if (!_shouldEmitBrowserConsoleMessage(level, args)) return;
        return _emitBrowserConsole__originalForDebugFilter.apply(this, arguments);
    };
    _emitBrowserConsole__wrappedForDebugFilter.__debugFilterWrapped = true;
    _emitBrowserConsole = _emitBrowserConsole__wrappedForDebugFilter;
}
function createPriorityBadgeElement(rows, row, onDone) {
        var badge = document.createElement('button');
        badge.type = 'button';
        badge.textContent = formatPriorityDisplay(rows.indexOf(row) + 1);
        applyPageToneBtnStyle(badge, 'width: 52px;height: 22px;padding: 0 4px;flex-shrink: 0;font-family: monospace;font-size: 8.5pt;margin-left: 1px;margin-right: 3px;');
        badge.addEventListener('click', function(e) {
            e.preventDefault();
            showPriorityEditModal(rows, row, onDone);
        });
        return badge;
    }

    function getLocalDictKeys() {
        var dicts = getUserDictsRaw();
        return Object.keys(dicts).sort(function(a, b) { return a.localeCompare(b); });
    }

    function refreshLocalDictSelect(preferredKey) {
        var currentVal = preferredKey || localDictSelect.value;
        while (localDictSelect.firstChild) localDictSelect.removeChild(localDictSelect.firstChild);
        var keys = getLocalDictKeys();
        keys.forEach(function(key) {
            var opt = document.createElement('option');
            opt.value = key;
            opt.textContent = key;
            localDictSelect.appendChild(opt);
        });
        if (keys.length === 0) {
            localDictSelect.value = '';
            return;
        }
        if (currentVal && keys.indexOf(currentVal) !== -1) localDictSelect.value = currentVal;
        else localDictSelect.value = keys[0];
    }

    function clearRightCol() {
        while (rightCol.firstChild) rightCol.removeChild(rightCol.firstChild);
        rightListDiv = null;
        rightBottomRow = null;
    }

    function clearActiveSelection() {
        currentSelection.type = null;
        currentSelection.key = null;
        currentSelection.elementKey = null;
    }

    function applyActiveStyles() {
        Array.from(navList.querySelectorAll('[data-nav-item="true"]')).forEach(function(el) {
            var matched = false;
            if (currentSelection.type === 'local' && el.dataset.itemType === 'local' && el.dataset.itemKey === currentSelection.elementKey) matched = true;
            if (currentSelection.type === 'external' && el.dataset.itemType === 'external' && el.dataset.itemKey === currentSelection.elementKey) matched = true;
            if (matched) {
                el.style.backgroundColor = '#5C0D12';
                el.style.color = '#FFFFFF';
                Array.from(el.querySelectorAll('span')).forEach(function(sp) { sp.style.color = '#FFFFFF'; });
            } else {
                el.style.backgroundColor = el.dataset.defaultBg || '#E0DED3';
                el.style.color = '#5C0D12';
                Array.from(el.querySelectorAll('span')).forEach(function(sp) { sp.style.color = ''; });
            }
        });
    }

    function setActiveLocalDict(dictKey, label) {
        currentSelection.type = 'local';
        currentSelection.key = dictKey;
        currentSelection.elementKey = dictKey;
        if (getCurrentSettingsSafe().autoSwitchDictDropdown) refreshLocalDictSelect(dictKey);
        applyActiveStyles();
        renderLocalDictPanel(dictKey, label || dictKey);
    }

    function setActiveExternalDict(dictKey) {
        currentSelection.type = 'external';
        currentSelection.key = dictKey;
        currentSelection.elementKey = dictKey;
        applyActiveStyles();
        clearRightCol();
        if (dictKey === 'kuromoji') {
            rightCol.appendChild(kuromojiItemsDiv);
            if (kuromojiItemsDiv.children.length === 0) renderKuromojiItems();
        } else if (dictKey === 'jmdict') {
            rightCol.appendChild(jmdictItemsDiv);
            if (jmdictItemsDiv.children.length === 0) renderJMdictItems();
        }
    }

    function renderCurrentSelectionSilently() {
        if (currentSelection.type === 'local' && currentSelection.key) {
            renderLocalDictPanel(currentSelection.key, currentSelection.key);
            applyActiveStyles();
            return;
        }
        if (currentSelection.type === 'external' && currentSelection.key) {
            setActiveExternalDict(currentSelection.key);
            applyActiveStyles();
            return;
        }
        clearRightCol();
        applyActiveStyles();
    }

    function showInputModal(titleText, placeholderText, defaultValue, confirmText, onConfirm) {
        if (modalOverlay) modalOverlay.remove();

        modalOverlay = document.createElement('div');
        modalOverlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 999999; display: flex; align-items: center; justify-content: center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'width: 360px; max-width: calc(100vw - 24px); background: #E0DED3; border: 1px solid #5C0D12; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); padding: 12px; box-sizing: border-box;';

        var titleEl = document.createElement('div');
        titleEl.textContent = titleText;
        titleEl.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 8px;';

        var input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue || '';
        input.placeholder = placeholderText || '';
        input.style.cssText = 'width: 100%; height: 26px; border: 1px solid #5C0D12; border-radius: 3px; background: #FAFAFA; color: #333; font-size: 9pt; padding: 0 8px; box-sizing: border-box; outline: none;';

        var hint = document.createElement('div');
        hint.textContent = 'Enter 確認，Esc 取消';
        hint.style.cssText = 'font-size: 8.5pt; color: #555; margin-top: 6px;';

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px;';

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        applyPageToneBtnStyle(cancelBtn, 'height: 24px;min-width: 64px;background: #FAFAFA;');

        var okBtn = document.createElement('button');
        okBtn.textContent = confirmText || '確認';
        applyPrimaryDarkBtnStyle(okBtn, 'height: 24px;min-width: 64px;');

        function closeModal() {
            document.removeEventListener('keydown', onKeyDown, true);
            if (modalOverlay) modalOverlay.remove();
            modalOverlay = null;
        }

        function submit() {
            var val = input.value.trim();
            if (!val) {
                input.focus();
                return;
            }
            var result = onConfirm ? onConfirm(val) : true;
            if (result !== false) closeModal();
        }

        function onKeyDown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeModal();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
        }

        cancelBtn.addEventListener('click', function(e) {
            e.preventDefault();
            closeModal();
        });

        okBtn.addEventListener('click', function(e) {
            e.preventDefault();
            submit();
        });

        modalOverlay.addEventListener('click', function(e) {
            if (e.target === modalOverlay) closeModal();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        modal.appendChild(titleEl);
        modal.appendChild(input);
        modal.appendChild(hint);
        modal.appendChild(btnRow);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        document.addEventListener('keydown', onKeyDown, true);
        setTimeout(function() {
            input.focus();
            input.select();
        }, 0);
    }

    function cleanExternalDict(dictKey) {
        return cleanExternalDictRewritten(dictKey, {
            renderKuromojiItems: renderKuromojiItems,
            renderJMdictItems: renderJMdictItems,
            currentSelection: currentSelection,
            setActiveExternalDict: setActiveExternalDict,
            renderCurrentSelectionSilently: renderCurrentSelectionSilently
        });
        var titleMap = { kuromoji: 'Kuromoji', jmdict: 'JMdict' };
        if (!confirm('確認要清空 ' + titleMap[dictKey] + ' 外部字典快取嗎？\n\n將刪除該字典在 IndexedDB 中的所有內容\n此操作無法復原')) return;
        if (!confirm('二次確認：將永久清空 ' + titleMap[dictKey] + ' 快取\n確定繼續？')) return;

        opLog('Clean 外部字典', { dictType: titleMap[dictKey] });

        var deleteKeys = [];
        if (dictKey === 'kuromoji') {
            deleteKeys = [
                'base.dat.gz','check.dat.gz','tid.dat.gz','tid_pos.dat.gz',
                'tid_map.dat.gz','cc.dat.gz','unk.dat.gz','unk_pos.dat.gz',
                'unk_map.dat.gz','unk_char.dat.gz','unk_compat.dat.gz','unk_invoke.dat.gz',
                'kuromoji_download_time'
            ];
        } else if (dictKey === 'jmdict') {
            deleteKeys = ['jmdict_data', 'jmdict_download_time', 'jmdict_reading_index'];
        }

        Promise.all(deleteKeys.map(function(key) {
            return dbDelete('dicts', key).catch(function() { return null; });
        })).then(function() {
            if (dictKey === 'kuromoji') renderKuromojiItems();
            if (dictKey === 'jmdict') renderJMdictItems();
            if (currentSelection.type === 'external' && currentSelection.key === dictKey) {
                setActiveExternalDict(dictKey);
            } else {
                renderCurrentSelectionSilently();
            }
        });
    }

    function addTopEntryToDict() {
        var dictKey = localDictSelect.value;
        var keyText = topKeyInput.value.trim();
        var valText = topValInput.value.trim();
        if (!dictKey) return;
        if (!keyText) {
            topKeyInput.focus();
            return;
        }

        var duplicateInfo = findLocalDictionaryDuplicateLoose(dictKey, keyText, null);
        if (duplicateInfo) {
            var dupeDelayMs = currentSettings.confirmBtnColorMs || 1000;
            flashColoredErrorState(topSaveBtn, 'Fail', 'Save', dupeDelayMs);
            return;
        }

        var dicts = getUserDictsRaw();
        if (!dicts[dictKey] || typeof dicts[dictKey] !== 'object') dicts[dictKey] = {};
        var exists = Object.prototype.hasOwnProperty.call(dicts[dictKey], keyText);

        function doSave() {
            var reorderedDict = {};
            reorderedDict[keyText] = valText;
            Object.keys(dicts[dictKey]).forEach(function(existingKey) {
                if (existingKey === keyText) return;
                reorderedDict[existingKey] = dicts[dictKey][existingKey];
            });
            var reorderedBottomDict = {};
            Object.keys(reorderedDict).forEach(function(existingKey) {
                if (existingKey === keyText) return;
                reorderedBottomDict[existingKey] = reorderedDict[existingKey];
            });
            reorderedBottomDict[keyText] = reorderedDict[keyText];
            dicts[dictKey] = reorderedBottomDict;
            setUserDictsRaw(dicts);
            localDictCache[dictKey] = null;
            delete editingRowsStateMap['rows_' + dictKey];
            opLog('新增本地詞條', { dictType: dictKey, key: keyText, value: valText });

            topKeyInput.value = '';
            topValInput.value = '';

            refreshLocalDictSelect(dictKey);
            flashButtonSavedState(topSaveBtn, '已儲存 ✓', 'Save', 1200);

            if (currentSelection.type === 'local' && currentSelection.key === dictKey) {
                renderLocalDictPanel(dictKey, dictKey);
            } else {
                applyActiveStyles();
            }
        }

        if (exists) {
            if (!confirm('鍵值 "' + keyText + '" 已存在於 ' + dictKey + ' 中，是否覆蓋？')) return;
        }
        doSave();
    }

    topSaveBtn.addEventListener('click', function(e) {
        e.preventDefault();
        addTopEntryToDict();
    });

    updateDictBtn.addEventListener('click', function(e) {
        e.preventDefault();
        triggerExternalDictUpdate(updateDictBtn);
    });

    topValInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addTopEntryToDict();
        }
    });

    topKeyInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addTopEntryToDict();
        }
    });

    localDictSelect.addEventListener('change', function() {
        if (this.value && currentSelection.type === 'local') {
            currentSelection.key = this.value;
            currentSelection.elementKey = this.value;
            applyActiveStyles();
            renderLocalDictPanel(this.value, this.value);
        }
    });

    function getLocalDictData(dictKey) {
        if (Object.prototype.hasOwnProperty.call(localDictCache, dictKey) && localDictCache[dictKey] !== null) return localDictCache[dictKey];
        var dicts = getUserDictsRaw();
        var raw = dicts[dictKey] || {};
        var entries = [];
        Object.keys(raw).forEach(function(k) {
            entries.push({ key: k, val: raw[k] });
        });
        localDictCache[dictKey] = entries;
        return entries;
    }

    function findLocalDictionaryDuplicateLoose(dictKey, sourceText, originalKey) {
        var normalizedSource = normalizeLocalDictExactKey(sourceText);
        if (!normalizedSource) return null;

        var dicts = getUserDictsRaw();
        var matched = null;

        Object.keys(dicts).some(function(currentDictKey) {
            var dictObj = dicts[currentDictKey];
            if (!dictObj || typeof dictObj !== 'object') return false;

            return Object.keys(dictObj).some(function(currentKey) {
                if (currentDictKey === dictKey && originalKey && currentKey === originalKey) return false;
                if (normalizeLocalDictExactKey(currentKey) !== normalizedSource) return false;
                matched = { dictKey: currentDictKey, key: currentKey };
                return true;
            });
        });

        return matched;
    }

    function validateLocalDictionaryRowsAgainstDuplicatesLoose(dictKey, rows) {
        var seen = {};
        var i;
        var finalKey;
        var normalizedKey;
        var duplicateInfo;

        for (i = 0; i < rows.length; i++) {
            finalKey = String((rows[i].editing && rows[i].checked ? rows[i].editKey : rows[i].key) || '').trim();
            normalizedKey = normalizeLocalDictExactKey(finalKey);
            if (!normalizedKey) continue;
            if (seen[normalizedKey]) return { dictKey: dictKey, key: finalKey };
            seen[normalizedKey] = true;
        }

        for (i = 0; i < rows.length; i++) {
            finalKey = String((rows[i].editing && rows[i].checked ? rows[i].editKey : rows[i].key) || '').trim();
            if (!finalKey) continue;
            duplicateInfo = findLocalDictionaryDuplicateLoose(dictKey, finalKey, rows[i].key);
            if (duplicateInfo) return duplicateInfo;
        }

        return null;
    }

    function rebuildLocalDictionaryFromRowsLoose(dictKey, rows) {
        var dicts = getUserDictsRaw();
        var rebuilt = {};

        rows.forEach(function(row) {
            var newKey = String((row.editing && row.checked ? row.editKey : row.key) || '').trim();
            var newVal = String((row.editing && row.checked ? row.editVal : row.val) || '');
            if (!newKey) return;

            rebuilt[newKey] = newVal;
            row.key = newKey;
            row.val = newVal;
            row.editKey = newKey;
            row.editVal = newVal;
            row.editing = false;
            row.checked = false;
        });

        dicts[dictKey] = rebuilt;
        setUserDictsRaw(dicts);
        return rebuilt;
    }

    function saveLocalDict(dictKey, rows) {
        rebuildLocalDictionaryFromRowsLoose(dictKey, rows);
        localDictCache[dictKey] = null;
        return;
        dicts[dictKey] = rebuildLocalDictObjectFromRows(rows, false);
        setUserDictsRaw(dicts);
        localDictCache[dictKey] = null;
        return;

        rows.forEach(function(row) {
            if (!row.checked) return;
            var oldKey = row.key;
            var newKey = (row.editing ? row.editKey : row.key);
            var newVal = (row.editing ? row.editVal : row.val);
            newKey = String(newKey || '').trim();
            if (!newKey) return;
            if (newKey !== oldKey && Object.prototype.hasOwnProperty.call(current, oldKey)) {
                delete current[oldKey];
            }
            current[newKey] = newVal;
        });

        dicts[dictKey] = current;
        setUserDictsRaw(dicts);
        localDictCache[dictKey] = null;
    }

    function deleteCheckedRows(dictKey, rows, onDone) {
        var checkedRows = rows.filter(function(row) { return row.checked; });
        if (checkedRows.length === 0) return;

        var dicts = getUserDictsRaw();
        var current = dicts[dictKey] || {};
        var deletedKeys = [];

        checkedRows.forEach(function(row) {
            if (Object.prototype.hasOwnProperty.call(current, row.key)) {
                delete current[row.key];
                deletedKeys.push(row.key);
            }
        });

        dicts[dictKey] = current;
        setUserDictsRaw(dicts);
        localDictCache[dictKey] = null;
        delete editingRowsStateMap['rows_' + dictKey];
        opLog('刪除勾選詞條', { dictType: dictKey, keys: deletedKeys });

        if (onDone) onDone();
    }

    function cleanLocalDict(dictKey, dictLabel, onDone) {
        if (!confirm('確認要清空 ' + dictLabel + ' 字典嗎？\n\n將刪除該字典內所有條目\n此操作無法復原')) return;
        if (!confirm('二次確認：將永久清空 ' + dictLabel + ' 字典\n確定繼續？')) return;
        var dicts = getUserDictsRaw();
        dicts[dictKey] = {};
        setUserDictsRaw(dicts);
        localDictCache[dictKey] = null;
        delete editingRowsStateMap['rows_' + dictKey];
        opLog('Clean 本地字典', { dictType: dictKey });
        if (onDone) onDone();
    }

    function copyTextToClipboardLoose(text, btn) {
        text = String(text || '');
        var done = function() {
            if (!btn) return;
            var oldText = btn.textContent;
            btn.textContent = '✓';
            setTimeout(function() {
                btn.textContent = oldText;
            }, 1000);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function() {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                try { document.execCommand('copy'); } catch (e) {}
                document.body.removeChild(ta);
                done();
            });
            return;
        }

        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try { document.execCommand('copy'); } catch (e2) {}
        document.body.removeChild(textarea);
        done();
    }

    function renderLocalDictPanel(dictKey, dictLabel) {
        currentLocalDict = dictKey;
        clearRightCol();

        var entries = getLocalDictData(dictKey);
        var cacheKey = 'rows_' + dictKey;
        var rows = editingRowsStateMap[cacheKey] || entries.map(function(e) {
            return { key: e.key, val: e.val, checked: false, editing: false, editKey: e.key, editVal: e.val };
        });
        editingRowsStateMap[cacheKey] = rows;

        rightListDiv = document.createElement('div');
        rightListDiv.style.cssText = 'flex: 1; overflow-y: auto;';

        rightBottomRow = document.createElement('div');
        rightBottomRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px; border-top: 1px solid #5C0D12; flex-shrink: 0; background: #E0DED3;';

        var leftActionWrap = document.createElement('div');
        leftActionWrap.style.cssText = 'display: flex; align-items: center; gap: 6px;';

        var rightActionWrap = document.createElement('div');
        rightActionWrap.style.cssText = 'display: flex; align-items: center; gap: 6px;';

        var selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '全選';
        applyPageToneBtnStyle(selectAllBtn, 'height: 24px;min-width: 64px;');

        var deselectAllBtn = document.createElement('button');
        deselectAllBtn.textContent = '取消';
        applyPageToneBtnStyle(deselectAllBtn, 'height: 24px;min-width: 64px;');

        var deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        applyPageToneBtnStyle(deleteBtn, 'height: 24px;min-width: 64px;');

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        applyPrimaryDarkBtnStyle(saveBtn, 'height: 24px;min-width: 64px;padding: 0 16px;');

        var allSaveBtn = document.createElement('button');
        allSaveBtn.textContent = 'All Save';
        applyPrimaryDarkBtnStyle(allSaveBtn, 'height: 24px;min-width: 64px;padding: 0 16px;');

        leftActionWrap.appendChild(selectAllBtn);
        leftActionWrap.appendChild(deselectAllBtn);
        rightActionWrap.appendChild(deleteBtn);
        rightActionWrap.appendChild(saveBtn);
        rightActionWrap.appendChild(allSaveBtn);
        rightBottomRow.appendChild(leftActionWrap);
        rightBottomRow.appendChild(rightActionWrap);

        rightCol.appendChild(rightListDiv);
        rightCol.appendChild(rightBottomRow);

        function normalizeRowsForCache() {
            editingRowsStateMap[cacheKey] = rows.map(function(r) {
                return {
                    key: r.key,
                    val: r.val,
                    checked: false,
                    editing: r.editing,
                    editKey: r.editing ? r.editKey : r.key,
                    editVal: r.editing ? r.editVal : r.val
                };
            });
            localDictCache[dictKey] = rows.map(function(r) {
                return { key: r.key, val: r.val };
            });
        }

        function flashDictManagerSaveFail(btn, restoreText) {
            var failDelayMs = _getConfirmFeedbackSettingsSafe().delayMs;
            flashColoredErrorState(btn, 'Fail', restoreText, failDelayMs);
        }

        function validateRowsBeforeSave(includeAllEdits) {
            validateRowsBeforeSave.lastDuplicateInfo = null;

            var rowsForDuplicateCheck = rows.map(function(row) {
                return {
                    key: row.key,
                    editKey: row.editKey,
                    editing: row.editing,
                    checked: includeAllEdits ? true : row.checked
                };
            });

            var duplicateInfo = validateLocalDictionaryRowsAgainstDuplicatesLoose(dictKey, rowsForDuplicateCheck);
            if (duplicateInfo) {
                validateRowsBeforeSave.lastDuplicateInfo = duplicateInfo;
                return false;
            }

            var newKeys = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (!(row.editing && (includeAllEdits || row.checked))) continue;
                var k = String(row.editKey || '').trim();
                if (!k) {
                    alert('存在空白鍵名，請修正後再保存');
                    return false;
                }
                if (newKeys[k]) {
                    alert('存在重複鍵名：' + k + '，請修正後再保存');
                    return false;
                }
                newKeys[k] = true;
            }
            return true;
        }

        function renderRows() {
            while (rightListDiv.firstChild) rightListDiv.removeChild(rightListDiv.firstChild);
            rows.forEach(function(row) {
                var rowDiv = document.createElement('div');
                rowDiv.style.cssText = 'display: flex; align-items: center; border-bottom: 1px solid rgba(92,13,18,0.15); background: #EDE9DF; padding: 1px 0; min-height: 23px;';

                if (row.editing) {
                    var cbEdit = document.createElement('input');
                    cbEdit.type = 'checkbox';
                    cbEdit.checked = !!row.checked;
                    cbEdit.style.cssText = 'width: 18px; height: 18px; flex-shrink: 0; margin: 0 4px; padding: 0; accent-color: #5C0D12; align-self: center; display: block; position: relative; top: 0;';
                    cbEdit.addEventListener('change', function() { row.checked = cbEdit.checked; });

                    var keyInput = document.createElement('input');
                    keyInput.type = 'text';
                    keyInput.value = row.editKey;
                    keyInput.style.cssText = 'flex: 1; min-width: 0; border: 1px solid #5C0D12; border-radius: 3px; background: #FAFAFA; margin: 0.5px 4px; font-size: 9pt; padding: 0 4px; height: 22px; line-height: 22px; box-sizing: border-box; outline: none; align-self: center;';
                    keyInput.addEventListener('input', function() { row.editKey = keyInput.value; });

                    var valInput = document.createElement('input');
                    valInput.type = 'text';
                    valInput.value = row.editVal;
                    valInput.style.cssText = 'flex: 1; min-width: 0; border: 1px solid #5C0D12; border-radius: 3px; background: #FAFAFA; margin: 0.5px 4px; font-size: 9pt; padding: 0 4px; height: 22px; line-height: 22px; box-sizing: border-box; outline: none; align-self: center;';
                    valInput.addEventListener('input', function() { row.editVal = valInput.value; });

                    var cancelBtn = document.createElement('button');
                    cancelBtn.textContent = 'X';
                    cancelBtn.style.cssText = 'width: 32px; flex-shrink: 0; border: none; background: #E0DED3; color: #5C0D12; font-weight: bold; font-size: 9pt; cursor: pointer; height: 22px; padding: 0;';
                    cancelBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        row.editing = false;
                        row.editKey = row.key;
                        row.editVal = row.val;
                        row.checked = false;
                        renderRows();
                    });

                    var editPriorityBadge = createPriorityBadgeElement(rows, row, renderRows);
                    rowDiv.appendChild(editPriorityBadge);
                    rowDiv.appendChild(cbEdit);
                    rowDiv.appendChild(keyInput);
                    rowDiv.appendChild(valInput);
                    rowDiv.appendChild(cancelBtn);

                    var editMoveUpBtn = document.createElement('button');
                    editMoveUpBtn.textContent = '↑';
                    applyPageToneBtnStyle(editMoveUpBtn, 'width: 22px;height: 22px;padding: 0;margin-right: 2px;flex-shrink: 0;');
                    var editCurrentIndex = rows.indexOf(row);
                    if (editCurrentIndex <= 0) {
                        editMoveUpBtn.style.opacity = '0.3';
                        editMoveUpBtn.style.cursor = 'default';
                    }
                    editMoveUpBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        var idx = rows.indexOf(row);
                        if (idx <= 0) return;
                        var tmp = rows[idx - 1];
                        rows[idx - 1] = rows[idx];
                        rows[idx] = tmp;
                        renderRows();
                    });

                    var editMoveDownBtn = document.createElement('button');
                    editMoveDownBtn.textContent = '↓';
                    applyPageToneBtnStyle(editMoveDownBtn, 'width: 22px;height: 22px;padding: 0;flex-shrink: 0;');
                    if (editCurrentIndex >= rows.length - 1) {
                        editMoveDownBtn.style.opacity = '0.3';
                        editMoveDownBtn.style.cursor = 'default';
                    }
                    editMoveDownBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        var idx = rows.indexOf(row);
                        if (idx < 0 || idx >= rows.length - 1) return;
                        var tmp = rows[idx + 1];
                        rows[idx + 1] = rows[idx];
                        rows[idx] = tmp;
                        renderRows();
                    });

                    rowDiv.appendChild(editMoveUpBtn);
                    rowDiv.appendChild(editMoveDownBtn);
                } else {
                    var cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = !!row.checked;
                    cb.style.cssText = 'width: 18px; height: 18px; flex-shrink: 0; margin: 0 4px; padding: 0; accent-color: #5C0D12; align-self: center; display: block; position: relative; top: 0;';
                    cb.addEventListener('change', function() { row.checked = cb.checked; });

                    var keySpan = document.createElement('span');
                    keySpan.textContent = row.key;
                    keySpan.style.cssText = 'flex: 1; min-width: 0; font-size: 9pt; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: 23px; line-height: 23px; cursor: pointer; display: block;';
                    keySpan.addEventListener('click', function(e) {
                        e.preventDefault();
                        row.checked = !row.checked;
                        renderRows();
                    });

                    var valSpan = document.createElement('span');
                    valSpan.textContent = row.val;
                    valSpan.style.cssText = 'flex: 1; min-width: 0; font-size: 9pt; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: 23px; line-height: 23px; cursor: pointer; display: block;';
                    valSpan.addEventListener('click', function(e) {
                        e.preventDefault();
                        row.checked = !row.checked;
                        renderRows();
                    });

                    var editBtn = document.createElement('button');
                    editBtn.textContent = '✎';
                    editBtn.style.cssText = 'width: 32px; flex-shrink: 0; border: none; background: #E0DED3; color: #5C0D12; font-weight: bold; font-size: 9pt; cursor: pointer; height: 22px; padding: 0;';
                    editBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        row.checked = true;
                        row.editing = true;
                        row.editKey = row.key;
                        row.editVal = row.val;
                        renderRows();
                    });

                    var viewPriorityBadge = createPriorityBadgeElement(rows, row, renderRows);
                    rowDiv.appendChild(viewPriorityBadge);
                    rowDiv.appendChild(cb);
                    rowDiv.appendChild(keySpan);

                    var keyCopyBtn = document.createElement('button');
                    keyCopyBtn.textContent = 'COPY';
                    applyPageToneBtnStyle(keyCopyBtn, 'height: 22px;min-width: 42px;padding: 0 6px;margin-right: 4px;flex-shrink: 0;');
                    keyCopyBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        copyTextToClipboardLoose(row.key, keyCopyBtn);
                    });
                    rowDiv.appendChild(keyCopyBtn);
                    rowDiv.appendChild(valSpan);

                    var valCopyBtn = document.createElement('button');
                    valCopyBtn.textContent = 'COPY';
                    applyPageToneBtnStyle(valCopyBtn, 'height: 22px;min-width: 42px;padding: 0 6px;margin-right: 4px;flex-shrink: 0;');
                    valCopyBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        copyTextToClipboardLoose(row.val, valCopyBtn);
                    });
                    rowDiv.appendChild(valCopyBtn);
                    rowDiv.appendChild(editBtn);

                    var viewMoveUpBtn = document.createElement('button');
                    viewMoveUpBtn.textContent = '↑';
                    applyPageToneBtnStyle(viewMoveUpBtn, 'width: 22px;height: 22px;padding: 0;margin-right: 2px;flex-shrink: 0;');
                    var viewCurrentIndex = rows.indexOf(row);
                    if (viewCurrentIndex <= 0) {
                        viewMoveUpBtn.style.opacity = '0.3';
                        viewMoveUpBtn.style.cursor = 'default';
                    }
                    viewMoveUpBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        var idx = rows.indexOf(row);
                        if (idx <= 0) return;
                        var tmp = rows[idx - 1];
                        rows[idx - 1] = rows[idx];
                        rows[idx] = tmp;
                        renderRows();
                    });

                    var viewMoveDownBtn = document.createElement('button');
                    viewMoveDownBtn.textContent = '↓';
                    applyPageToneBtnStyle(viewMoveDownBtn, 'width: 22px;height: 22px;padding: 0;flex-shrink: 0;');
                    if (viewCurrentIndex >= rows.length - 1) {
                        viewMoveDownBtn.style.opacity = '0.3';
                        viewMoveDownBtn.style.cursor = 'default';
                    }
                    viewMoveDownBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        var idx = rows.indexOf(row);
                        if (idx < 0 || idx >= rows.length - 1) return;
                        var tmp = rows[idx + 1];
                        rows[idx + 1] = rows[idx];
                        rows[idx] = tmp;
                        renderRows();
                    });

                    rowDiv.appendChild(viewMoveUpBtn);
                    rowDiv.appendChild(viewMoveDownBtn);
                }

                Array.from(rowDiv.querySelectorAll('button')).forEach(function(btn) {
                    btn.style.marginTop = '1px';
                    btn.style.marginBottom = '1px';
                });
                rightListDiv.appendChild(rowDiv);
            });
        }

        selectAllBtn.addEventListener('click', function(e) {
            e.preventDefault();
            rows.forEach(function(row) { row.checked = true; });
            renderRows();
        });

        deselectAllBtn.addEventListener('click', function(e) {
            e.preventDefault();
            rows.forEach(function(row) { row.checked = false; });
            renderRows();
        });

        var deleteConfirmPending = false;
        var deleteConfirmTimer = null;
        var deleteConfirmFeedbackController = null;

        function resetLocalDictDeleteConfirmState() {
            deleteConfirmPending = false;
            if (deleteConfirmTimer) {
                clearTimeout(deleteConfirmTimer);
                deleteConfirmTimer = null;
            }
            if (deleteConfirmFeedbackController && typeof deleteConfirmFeedbackController.restore === 'function') {
                deleteConfirmFeedbackController.restore();
                deleteConfirmFeedbackController = null;
            }
        }

        deleteBtn.addEventListener('click', function(e) {
            e.preventDefault();
            var hadChecked = rows.some(function(row) { return row.checked; });
            if (!hadChecked) {
                resetLocalDictDeleteConfirmState();
                return;
            }

            if (getCurrentSettingsSafe().deleteDoubleConfirm) {
                if (!deleteConfirmPending) {
                    deleteConfirmPending = true;
                    deleteConfirmFeedbackController = _beginFeedbackState(deleteBtn, {
                        useColor: true,
                        colorType: 'error'
                    });
                    deleteConfirmTimer = setTimeout(function() {
                        resetLocalDictDeleteConfirmState();
                    }, getCurrentSettingsSafe().doubleConfirmMs || 1000);
                    return;
                }
                resetLocalDictDeleteConfirmState();
            }
            if (!hadChecked) return;
            deleteCheckedRows(dictKey, rows, function() {
                rows = rows.filter(function(row) { return !row.checked; });
                normalizeRowsForCache();
                renderLocalDictPanel(dictKey, dictLabel);
            });
        });

        allSaveBtn.addEventListener('click', function(e) {
            e.preventDefault();
            if (!validateRowsBeforeSave(true)) {
                flashDictManagerSaveFail(allSaveBtn, 'All Save');
                return;
            }

            try {
                saveAllLocalDictRows(dictKey, rows);
                normalizeRowsForCache();
                opLog('All Save 本地字典', { dictType: dictKey, count: rows.length });
                renderRows();
                flashButtonSavedState(allSaveBtn, '已儲存 ✓', 'All Save', 1000);
            } catch (err) {
                errorLog('DictManager', 'All Save 失敗', err);
                flashDictManagerSaveFail(allSaveBtn, 'All Save');
            }
        });

        saveBtn.addEventListener('click', function(e) {
            e.preventDefault();
            if (!validateRowsBeforeSave(false)) {
                flashDictManagerSaveFail(saveBtn, 'Save');
                return;
            }

            try {
                var changedItems = [];
                rows.forEach(function(row) {
                    if (row.editing && row.checked) {
                        changedItems.push({
                            oldKey: row.key,
                            newKey: row.editKey,
                            newValue: row.editVal
                        });
                        row.key = row.editKey;
                        row.val = row.editVal;
                        row.editing = false;
                    }
                });

                saveLocalDict(dictKey, rows);
                normalizeRowsForCache();
                if (changedItems.length > 0) {
                    opLog('保存已編輯詞條', { dictType: dictKey, items: changedItems });
                }
                renderRows();
                flashButtonSavedState(saveBtn, '已儲存 ✓', 'Save', 1000);
            } catch (err) {
                errorLog('DictManager', 'Save 失敗', err);
                flashDictManagerSaveFail(saveBtn, 'Save');
            }
        });

        renderRows();
    }

    function makeGroupHeader(label, stateKey, onClick) {
        var hdr = document.createElement('div');
        hdr.dataset.navItem = 'true';
        hdr.dataset.itemType = 'group';
        hdr.dataset.itemKey = stateKey;
        hdr.dataset.defaultBg = '#D8D5C6';
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
            if (onClick) onClick(groupStates[stateKey]);
            renderNav();
        });
        return hdr;
    }

    function makeSubGroupHeader(label, stateKey, onClick) {
        var hdr = document.createElement('div');
        hdr.dataset.navItem = 'true';
        hdr.dataset.itemType = 'external';
        hdr.dataset.itemKey = stateKey;
        hdr.dataset.defaultBg = '#DCD9CA';
        hdr.style.cssText = 'font-size: 9pt; font-weight: bold; color: #5C0D12; padding: 4px 8px 4px 20px; user-select: none; cursor: pointer; background: #DCD9CA; border-bottom: 1px solid rgba(92,13,18,0.2); display: flex; align-items: center; gap: 4px;';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        labelSpan.style.cssText = 'flex: 1;';
        var cleanBtn = document.createElement('button');
        cleanBtn.textContent = 'Clean';
        applyPageToneBtnStyle(cleanBtn, 'font-size: 8pt;padding: 0 4px;height: 18px;border-radius: 2px;flex-shrink: 0;');
        cleanBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            cleanExternalDict(stateKey);
        });
        hdr.appendChild(labelSpan);
        hdr.appendChild(cleanBtn);
        hdr.addEventListener('click', function(e) {
            e.preventDefault();
            if (onClick) onClick();
        });
        return hdr;
    }

    function makeLocalDictItem(label, dictKey) {
        var item = document.createElement('div');
        item.dataset.navItem = 'true';
        item.dataset.itemType = 'local';
        item.dataset.itemKey = dictKey;
        item.dataset.defaultBg = '#E0DED3';
        item.style.cssText = 'font-size: 9pt; color: #5C0D12; padding: 4px 8px 4px 20px; border-bottom: 1px solid rgba(92,13,18,0.15); background: #E0DED3; display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        labelSpan.style.cssText = 'flex: 1;';
        var cleanBtn = document.createElement('button');
        cleanBtn.textContent = 'Clean';
        applyPageToneBtnStyle(cleanBtn, 'font-size: 8pt;padding: 0 4px;height: 18px;border-radius: 2px;flex-shrink: 0;');
        cleanBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            cleanLocalDict(dictKey, label, function() {
                renderNav();
                refreshLocalDictSelect(dictKey);
                if (currentSelection.type === 'local' && currentSelection.key === dictKey) {
                    renderLocalDictPanel(dictKey, label);
                } else {
                    renderCurrentSelectionSilently();
                }
            });
        });
        item.appendChild(labelSpan);
        item.appendChild(cleanBtn);
        item.addEventListener('click', function(e) {
            e.preventDefault();
            setActiveLocalDict(dictKey, label);
        });
        return item;
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
                    return { name: f, cached: (val !== null && val !== undefined), raw: val };
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
            summaryName.textContent = allCached ? ('全部已下載' + (savedTime ? ' （本地時間: ' + new Date(savedTime).toLocaleDateString() + '）' : '')) : ('已下載: ' + fileResults.filter(function(r) { return r.cached; }).length + '/' + files.length);
            var summaryRight = document.createElement('div');
            summaryRight.style.cssText = 'display: flex; align-items: center; gap: 8px;';
            var summarySize = document.createElement('span');
            summarySize.textContent = 'N/A';
            summarySize.style.cssText = 'min-width: 56px; text-align: right; color: #666;';
            var summaryStatus = document.createElement('span');
            summaryStatus.textContent = allCached ? '✓' : '✗';
            summaryStatus.style.color = allCached ? '#007700' : '#CC0000';
            summaryRight.appendChild(summarySize);
            summaryRight.appendChild(summaryStatus);
            summaryRow.appendChild(summaryName);
            summaryRow.appendChild(summaryRight);
            kuromojiItemsDiv.appendChild(summaryRow);

            fileResults.forEach(function(r) {
                var row = document.createElement('div');
                row.style.cssText = 'font-size: 8.5pt; padding: 2px 8px 2px 32px; border-bottom: 1px solid rgba(92,13,18,0.1); color: #333; background: #E0DED3; display: flex; justify-content: space-between; align-items: center;';
                var nameSpan = document.createElement('span');
                nameSpan.textContent = r.name;
                var rightWrap = document.createElement('div');
                rightWrap.style.cssText = 'display: flex; align-items: center; gap: 8px;';
                var sizeSpan = document.createElement('span');
                sizeSpan.textContent = r.cached ? formatReadableSize(r.raw) : 'N/A';
                sizeSpan.style.cssText = 'min-width: 56px; text-align: right; color: #666;';
                var statusSpan = document.createElement('span');
                statusSpan.textContent = r.cached ? '✓' : '✗';
                statusSpan.style.color = r.cached ? '#007700' : '#CC0000';
                rightWrap.appendChild(sizeSpan);
                rightWrap.appendChild(statusSpan);
                row.appendChild(nameSpan);
                row.appendChild(rightWrap);
                kuromojiItemsDiv.appendChild(row);
            });
        });
    }

    function renderJMdictItems() {
        return renderJMdictItemsRewritten(jmdictItemsDiv);
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
            var rightWrap = document.createElement('div');
            rightWrap.style.cssText = 'display: flex; align-items: center; gap: 8px;';
            var sizeSpan = document.createElement('span');
            sizeSpan.style.cssText = 'min-width: 56px; text-align: right; color: #666;';
            var statusSpan = document.createElement('span');

            if (!hasData) {
                nameSpan.textContent = '未下載';
                sizeSpan.textContent = 'N/A';
                statusSpan.textContent = '✗';
                statusSpan.style.color = '#CC0000';
                rightWrap.appendChild(sizeSpan);
                rightWrap.appendChild(statusSpan);
                statusRow.appendChild(nameSpan);
                statusRow.appendChild(rightWrap);
                jmdictItemsDiv.appendChild(statusRow);
                return;
            }

            nameSpan.textContent = '條目數: ' + data.length + (savedTime ? ' （本地時間: ' + new Date(savedTime).toLocaleDateString() + '）' : '');
            sizeSpan.textContent = 'N/A';
            statusSpan.textContent = '✓';
            statusSpan.style.color = '#007700';
            rightWrap.appendChild(sizeSpan);
            rightWrap.appendChild(statusSpan);
            statusRow.appendChild(nameSpan);
            statusRow.appendChild(rightWrap);
            jmdictItemsDiv.appendChild(statusRow);
        });
    }

    function updateAllDicts(btn) {
        return updateAllDictsRewritten(btn, {
            renderKuromojiItems: renderKuromojiItems,
            renderJMdictItems: renderJMdictItems,
            currentSelection: currentSelection,
            setActiveExternalDict: setActiveExternalDict
        });
        btn.disabled = true;
        btn.textContent = '更新中...';
        opLog('Update Dict 開始', { target: 'external dictionaries' });

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
                            if (commits && commits.length > 0) resolve(new Date(commits[0].commit.committer.date).getTime());
                            else resolve(null);
                        } catch (e) {
                            resolve(null);
                        }
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
                        } catch (e) {
                            resolve(null);
                        }
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
                        if (resp.status >= 200 && resp.status < 300) resolve(resp.response);
                        else reject(new Error('HTTP ' + resp.status));
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
                        if (resp.status >= 200 && resp.status < 300) resolve(resp.response);
                        else reject(new Error('HTTP ' + resp.status));
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

            var chain = Promise.resolve();

            if (needKuromoji) {
                chain = chain.then(function() {
                    return KUROMOJI_FILES.reduce(function(fileChain, fileName) {
                        return fileChain.then(function() {
                            return downloadKuromojiFile(fileName).then(function(buffer) {
                                return dbSet('dicts', fileName, buffer);
                            });
                        });
                    }, Promise.resolve());
                }).then(function() {
                    return dbSet('dicts', 'kuromoji_download_time', Date.now());
                });
            }

            if (needJMdict) {
                chain = chain.then(function() {
                    return downloadJMdictFull();
                }).then(function(buffer) {
                    var _origSetImmediate = typeof setImmediate !== 'undefined' ? setImmediate : null;
                    if (_origSetImmediate) setImmediate = function(fn) { setTimeout(fn, 0); };
                    return JSZip.loadAsync(buffer).then(function(zip) {
                        var jsonFiles = [];
                        zip.forEach(function(path, entry) {
                            if (!entry.dir && path.indexOf('term_bank_') !== -1 && path.slice(-5) === '.json') jsonFiles.push(entry);
                        });
                        var allEntries = [];
                        return jsonFiles.reduce(function(zipChain, entry) {
                            return zipChain.then(function() {
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
                                                if (expression && glossary.length > 0) allEntries.push({ expression: expression, reading: reading, glossary: glossary });
                                            }
                                        });
                                    } catch (e) {}
                                });
                            });
                        }, Promise.resolve()).then(function() {
                            if (_origSetImmediate) setImmediate = _origSetImmediate;
                            return allEntries;
                        });
                    });
                }).then(function(allEntries) {
                    return dbSet('dicts', 'jmdict_data', allEntries).then(function() {
                        return dbSet('dicts', 'jmdict_download_time', Date.now());
                    });
                });
            }

            return chain;
        }).then(function() {
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
                    dbSet('dicts', 'jmdict_reading_index', index);
                }
            }).finally(function() {
                renderKuromojiItems();
                renderJMdictItems();
                if (currentSelection.type === 'external' && currentSelection.key) {
                    setActiveExternalDict(currentSelection.key);
                }
                opLog('Update Dict 完成', { kuromoji: true, jmdict: true });
                setTimeout(function() {
                    btn.textContent = 'Update Dict';
                    btn.disabled = false;
                }, 1200);
            });
        }).catch(function(err) {
            errorLog('DictManager', 'Update Dict 失敗', err && (err.message || String(err)));
            btn.textContent = '更新失敗';
            setTimeout(function() {
                btn.textContent = 'Update Dict';
                btn.disabled = false;
            }, 1500);
        });
    }

    function renderNav() {
        navList.innerHTML = '';

        navList.appendChild(makeGroupHeader('本地字典', 'local', function(expanded) {
            if (!expanded && currentSelection.type === 'local') {
                clearRightCol();
                clearActiveSelection();
            }
        }));

        if (groupStates.local) {
            getLocalDictKeys().forEach(function(key) {
                navList.appendChild(makeLocalDictItem(key, key));
            });
        }

        navList.appendChild(makeGroupHeader('外部字典', 'external', function(expanded) {
            if (!expanded) {
                clearRightCol();
                if (currentSelection.type === 'external') clearActiveSelection();
                groupStates.kuromoji = false;
                groupStates.jmdict = false;
            }
        }));

        if (groupStates.external) {
            navList.appendChild(makeSubGroupHeader('Kuromoji', 'kuromoji', function() {
                groupStates.kuromoji = true;
                groupStates.jmdict = false;
                setActiveExternalDict('kuromoji');
                renderNav();
            }));
            navList.appendChild(makeSubGroupHeader('JMdict', 'jmdict', function() {
                groupStates.jmdict = true;
                groupStates.kuromoji = false;
                setActiveExternalDict('jmdict');
                renderNav();
            }));
        }

        applyActiveStyles();
    }

    addLocalDictBtn.addEventListener('click', function(e) {
        e.preventDefault();
        showInputModal('新增本地字典', '請輸入新增的本地字典名稱', '', '新增', function(val) {
            var dicts = getUserDictsRaw();
            if (Object.prototype.hasOwnProperty.call(dicts, val)) {
                alert('字典已存在');
                return false;
            }
            dicts[val] = {};
            setUserDictsRaw(dicts);
            localDictCache[val] = null;
            delete editingRowsStateMap['rows_' + val];
            groupStates.local = true;
            refreshLocalDictSelect(val);
            opLog('新增字典', { dictType: val });
            renderNav();
            setActiveLocalDict(val, val);
            return true;
        });
    });

    renameLocalDictBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (currentSelection.type !== 'local' || !currentSelection.key) return;
        var oldKey = currentSelection.key;
        showInputModal('本地字典更名', '請輸入新的字典名稱', oldKey, '確認', function(val) {
            var dicts = getUserDictsRaw();
            if (!Object.prototype.hasOwnProperty.call(dicts, oldKey)) return false;
            if (val !== oldKey && Object.prototype.hasOwnProperty.call(dicts, val)) {
                alert('字典名稱已存在');
                return false;
            }
            dicts[val] = dicts[oldKey];
            if (val !== oldKey) delete dicts[oldKey];
            setUserDictsRaw(dicts);

            if (Object.prototype.hasOwnProperty.call(localDictCache, oldKey)) {
                localDictCache[val] = localDictCache[oldKey];
                delete localDictCache[oldKey];
            }
            if (Object.prototype.hasOwnProperty.call(editingRowsStateMap, 'rows_' + oldKey)) {
                editingRowsStateMap['rows_' + val] = editingRowsStateMap['rows_' + oldKey];
                delete editingRowsStateMap['rows_' + oldKey];
            }

            opLog('更名字典', { oldName: oldKey, newName: val });
            refreshLocalDictSelect(val);
            renderNav();
            setActiveLocalDict(val, val);
            return true;
        });
    });

    deleteLocalDictBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (currentSelection.type !== 'local' || !currentSelection.key) return;
        var dictKey = currentSelection.key;
        if (!confirm('確認要刪除本地字典 "' + dictKey + '" 嗎？\n\n此操作會徹底刪除該字典及其所有條目，且不會自動重建。')) return;
        if (!confirm('二次確認：將永久刪除 "' + dictKey + '"，確定繼續？')) return;

        var dicts = getUserDictsRaw();
        delete dicts[dictKey];
        setUserDictsRaw(dicts);
        delete localDictCache[dictKey];
        delete editingRowsStateMap['rows_' + dictKey];

        opLog('刪除字典', { dictType: dictKey });

        refreshLocalDictSelect();
        clearRightCol();
        clearActiveSelection();
        renderNav();
    });

    leftCol.appendChild(navList);
    leftCol.appendChild(leftBottomBar);

    container.refreshPanel = function() {
        refreshLocalDictSelect();
        renderNav();
        renderCurrentSelectionSilently();
    };

    _dictManagerUpdateFn = updateAllDicts;
    _dictManagerRefreshFns.kuromoji = function() {
        renderKuromojiItems();
        if (currentSelection.type === 'external' && currentSelection.key === 'kuromoji') setActiveExternalDict('kuromoji');
    };
    _dictManagerRefreshFns.jmdict = function() {
        renderJMdictItems();
        if (currentSelection.type === 'external' && currentSelection.key === 'jmdict') setActiveExternalDict('jmdict');
    };

    refreshLocalDictSelect();
    renderNav();
    clearRightCol();

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
    applyPageToneBtnStyle(clearBtn, 'padding: 2px 16px;height: 24px;');
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
    applyPageToneBtnStyle(btnNewTpl, 'flex: 1;height: 22px;');

    var btnDelTpl = document.createElement('button');
    btnDelTpl.textContent = '刪除';
    applyPageToneBtnStyle(btnDelTpl, 'flex: 1;height: 22px;');

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
    applyPrimaryDarkBtnStyle(btnSaveTpl, 'height: 22px;padding: 2px 16px;border: none;');

    var btnCancelTpl = document.createElement('button');
    btnCancelTpl.textContent = '取消';
    applyPageToneBtnStyle(btnCancelTpl, 'height: 22px;padding: 2px 16px;');

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

    function renderList() {
        while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
        var templates = getCommentTemplatesSafe();
        templates.forEach(function(tpl) {
            var item = document.createElement('div');
            item.style.cssText = 'padding: 5px 8px; font-size: 9pt; cursor: pointer; border-bottom: 1px solid #D0CEC3; word-break: break-all; background-color: #E0DED3;';
            item.textContent = tpl.name || '(無名稱)';
            item.dataset.id = tpl.id;
            if (tpl.id === selectedId) {
                item.style.backgroundColor = '#5C0D12';
                item.style.color = '#FFFFFF';
            }
            item.addEventListener('click', function() {
                selectedId = tpl.id;
                isNew = false;
                nameInput.value = tpl.name;
                contentTextarea.value = tpl.content;
                renderList();
            });
            listBox.appendChild(item);
        });
    }

    function clearRight() {
        nameInput.value = '';
        contentTextarea.value = '';
        selectedId = null;
        isNew = false;
        renderList();
    }

    btnNewTpl.addEventListener('click', function(e) {
        e.preventDefault();
        selectedId = null;
        isNew = true;
        nameInput.value = '';
        contentTextarea.value = '';
        renderList();
        nameInput.focus();
    });

    btnDelTpl.addEventListener('click', function(e) {
        e.preventDefault();
        if (!selectedId) return;
        var templates = getCommentTemplatesSafe();
        var deleting = templates.find(function(t) { return t.id === selectedId; });
        saveCommentTemplatesSafe(templates.filter(function(t) { return t.id !== selectedId; }));
        opLog('刪除範本', { id: selectedId, name: deleting ? deleting.name : '' });
        clearRight();
        syncAllCommentTemplateDropdowns();
    });

    btnSaveTpl.addEventListener('click', function(e) {
        e.preventDefault();
        var name = nameInput.value.trim();
        if (!name) {
            nameInput.focus();
            return;
        }
        var content = contentTextarea.value;
        var templates = getCommentTemplatesSafe();
        if (isNew || !selectedId) {
            var newId = 'tpl_' + Date.now();
            templates.push({ id: newId, name: name, content: content });
            selectedId = newId;
            isNew = false;
            opLog('保存範本', { action: 'create', id: newId, name: name });
        } else {
            templates = templates.map(function(t) {
                return t.id === selectedId ? { id: t.id, name: name, content: content } : t;
            });
            opLog('保存範本', { action: 'update', id: selectedId, name: name });
        }
        saveCommentTemplatesSafe(templates);
        renderList();
        syncAllCommentTemplateDropdowns();
        flashButtonSavedState(btnSaveTpl, '已儲存 ✓', '儲存', 1500);
    });

    btnCancelTpl.addEventListener('click', function(e) {
        e.preventDefault();
        clearRight();
    });

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
    applyPageToneBtnStyle(sortGoBtn, 'padding: 0 8px;height: 20px;line-height: 18px;flex-shrink: 0;');
    topRow.appendChild(sortGoBtn);

    var galleryFileLabel = document.createElement('span');
    galleryFileLabel.textContent = 'Gallery File:';
    galleryFileLabel.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; color: #5C0D12; font-weight: bold; margin-left: 8px;';
    topRow.appendChild(galleryFileLabel);

    var actionSelect = document.createElement('select');
    applySelectStyle(actionSelect, '70px');
    actionSelect.style.flexShrink = '0';
    var saveOpt = document.createElement('option'); saveOpt.value = 'save'; saveOpt.textContent = 'Save'; actionSelect.appendChild(saveOpt);
    var delOpt = document.createElement('option'); delOpt.value = 'delete'; delOpt.textContent = 'Delete'; actionSelect.appendChild(delOpt);
    topRow.appendChild(actionSelect);

    var actionGoBtn = document.createElement('button');
    actionGoBtn.textContent = 'GO';
    applyPageToneBtnStyle(actionGoBtn, 'padding: 0 8px;height: 20px;line-height: 18px;flex-shrink: 0;');
    topRow.appendChild(actionGoBtn);

    var fileListAllSaveBtn = document.createElement('button');
    fileListAllSaveBtn.textContent = 'All Save';
    applyPrimaryDarkBtnStyle(fileListAllSaveBtn, 'padding: 0 16px;height: 20px;line-height: 18px;flex-shrink: 0;');


    container.appendChild(topRow);

    var tabRow = document.createElement('div');
    tabRow.style.cssText = 'display: flex; gap: 0; margin-bottom: 8px; border-bottom: 1px solid #5C0D12;';

    var fileListTab = document.createElement('button');
    fileListTab.type = 'button';
    fileListTab.textContent = 'Show File List';
    fileListTab.style.cssText = 'background-color: #5C0D12; color: #FFFFFF; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0;';

    var folderManagerTab = document.createElement('button');
    folderManagerTab.type = 'button';
    folderManagerTab.textContent = 'Folder Manager';
    folderManagerTab.style.cssText = 'background-color: #E3E0D1; color: #5C0D12; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0; margin-left: 4px;';

    var fileRenamerTab = document.createElement('button');
    fileRenamerTab.type = 'button';
    fileRenamerTab.textContent = 'File Renamer';
    fileRenamerTab.style.cssText = 'background-color: #E3E0D1; color: #5C0D12; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0; margin-left: 4px;';

    var importExportTab = document.createElement('button');
    importExportTab.type = 'button';
    importExportTab.textContent = 'Import/Export';
    importExportTab.style.cssText = 'background-color: #E3E0D1; color: #5C0D12; border: 1px solid #5C0D12; border-bottom: none; font-size: 9pt; font-weight: bold; padding: 3px 12px; cursor: pointer; border-radius: 3px 3px 0 0; margin-left: 4px;';

    tabRow.appendChild(fileListTab);
    tabRow.appendChild(folderManagerTab);
    tabRow.appendChild(fileRenamerTab);
    tabRow.appendChild(importExportTab);
    container.appendChild(tabRow);

    var fileListPanel = document.createElement('div');
    fileListPanel.style.cssText = 'display: block;';

    var fileListTopRow = document.createElement('div');
    fileListTopRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
    var sortAscBtn = document.createElement('button');
    sortAscBtn.textContent = '升序 ↑';
    applyPageToneBtnStyle(sortAscBtn, 'padding: 2px 10px;height: 22px;');
    var sortDescBtn = document.createElement('button');
    sortDescBtn.textContent = '降序 ↓';
    applyPageToneBtnStyle(sortDescBtn, 'padding: 2px 10px;height: 22px;');
    var fileListSpacer = document.createElement('div'); fileListSpacer.style.cssText = 'flex: 1;';
    var selectAllBtn = document.createElement('button');
    selectAllBtn.textContent = '全選';
    applyPageToneBtnStyle(selectAllBtn, 'padding: 2px 10px;height: 22px;');
    var deselectAllBtn = document.createElement('button');
    deselectAllBtn.textContent = '取消全選';
    applyPageToneBtnStyle(deselectAllBtn, 'padding: 2px 10px;height: 22px;');
    var fileListRestoreBtn = document.createElement('button');
    fileListRestoreBtn.textContent = 'Restore';
    applyPageToneBtnStyle(fileListRestoreBtn, 'padding: 2px 10px;height: 22px;');
    fileListTopRow.appendChild(sortAscBtn);
    fileListTopRow.appendChild(sortDescBtn);
    fileListTopRow.appendChild(fileListSpacer);
    fileListTopRow.appendChild(selectAllBtn);
    fileListTopRow.appendChild(deselectAllBtn);
    fileListTopRow.appendChild(fileListRestoreBtn);
    fileListTopRow.appendChild(fileListAllSaveBtn);
    fileListPanel.appendChild(fileListTopRow);

    var listContainer = document.createElement('div');
    listContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
    fileListPanel.appendChild(listContainer);


    container.appendChild(fileListPanel);

    var folderManagerPanel = document.createElement('div');
    folderManagerPanel.style.cssText = 'display: none;';

    var folderListContainer = document.createElement('div');
    folderListContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
    folderManagerPanel.appendChild(folderListContainer);

    var folderBottomRow = document.createElement('div');
    folderBottomRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 8px;';
    var saveFolderBtn = document.createElement('button');
    saveFolderBtn.textContent = 'Save';
    applyPrimaryDarkBtnStyle(saveFolderBtn, 'padding: 4px 16px;border: none;');
    folderBottomRow.appendChild(saveFolderBtn);
    folderManagerPanel.appendChild(folderBottomRow);
    container.appendChild(folderManagerPanel);

    var fileRenamerPanel = document.createElement('div');
    fileRenamerPanel.style.cssText = 'display: none;';

    var renamerTopRow = document.createElement('div');
    renamerTopRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
    var renamerSortAscBtn = document.createElement('button');
    renamerSortAscBtn.textContent = '升序 ↑';
    applyPageToneBtnStyle(renamerSortAscBtn, 'padding: 2px 10px;height: 22px;');
    var renamerSortDescBtn = document.createElement('button');
    renamerSortDescBtn.textContent = '降序 ↓';
    applyPageToneBtnStyle(renamerSortDescBtn, 'padding: 2px 10px;height: 22px;');
    var renamerSpacer = document.createElement('div'); renamerSpacer.style.cssText = 'flex: 1;';
    var renamerSelectAllBtn = document.createElement('button');
    renamerSelectAllBtn.textContent = '全選';
    applyPageToneBtnStyle(renamerSelectAllBtn, 'padding: 2px 10px;height: 22px;');
    var renamerDeselectAllBtn = document.createElement('button');
    renamerDeselectAllBtn.textContent = '取消全選';
    applyPageToneBtnStyle(renamerDeselectAllBtn, 'padding: 2px 10px;height: 22px;');
    var renamerRestoreBtn = document.createElement('button');
    renamerRestoreBtn.textContent = 'Restore';
    applyPageToneBtnStyle(renamerRestoreBtn, 'padding: 2px 10px;height: 22px;');
    var renamerAllSaveBtn = document.createElement('button');
    renamerAllSaveBtn.textContent = 'All Save';
    applyPrimaryDarkBtnStyle(renamerAllSaveBtn, 'padding: 0 16px;height: 22px;line-height: 20px;flex-shrink: 0;');

    renamerTopRow.appendChild(renamerSortAscBtn);
    renamerTopRow.appendChild(renamerSortDescBtn);
    renamerTopRow.appendChild(renamerSpacer);
    renamerTopRow.appendChild(renamerSelectAllBtn);
    renamerTopRow.appendChild(renamerDeselectAllBtn);
    renamerTopRow.appendChild(renamerRestoreBtn);
    renamerTopRow.appendChild(renamerAllSaveBtn);
    fileRenamerPanel.appendChild(renamerTopRow);

    var renamerListContainer = document.createElement('div');
    renamerListContainer.style.cssText = 'border: 1px solid #5C0D12; background-color: rgb(227,224,209); min-height: 120px; max-height: 400px; overflow-y: auto;';
    fileRenamerPanel.appendChild(renamerListContainer);

    container.appendChild(fileRenamerPanel);

    var importExportPanel = document.createElement('div');
    importExportPanel.style.cssText = 'display: none;';

    var importExportTopRow = document.createElement('div');
    importExportTopRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

    var importExportExportBtn = document.createElement('button');
    importExportExportBtn.textContent = '導出';
    applyPageToneBtnStyle(importExportExportBtn, 'padding: 2px 12px;height: 22px;');

    var importExportImportBtn = document.createElement('button');
    importExportImportBtn.textContent = '導入';
    applyPageToneBtnStyle(importExportImportBtn, 'padding: 0 12px;height: 22px;line-height: 20px;');

    importExportTopRow.appendChild(importExportExportBtn);
    importExportTopRow.appendChild(importExportImportBtn);
    importExportPanel.appendChild(importExportTopRow);

    var importExportTextareaEl = document.createElement('textarea');
    importExportTextareaEl.style.cssText = 'width: 100%; height: 220px; min-height: 220px; max-height: 220px; box-sizing: border-box; border: 1px solid #5C0D12; background-color: rgb(227,224,209); font-size: 9pt; padding: 6px; resize: none; overflow-x: auto; overflow-y: auto; font-family: monospace; white-space: pre; word-break: normal;';
    importExportTextareaEl.placeholder = '點擊「導出」生成 {"files":[...]}，或貼上 JSON 後點擊「導入」';
    importExportPanel.appendChild(importExportTextareaEl);

    importExportTextarea = importExportTextareaEl;
    container.appendChild(importExportPanel);

    var currentFiles = [];
    var currentGalleryId = null;
    var dragSrcIndex = null;
    var currentSortMethod = 'natural';
    var currentSortDirection = 'asc';
    var pendingDeletedGalleryFileKeys = [];
    var renamerCurrentSortDirection = 'asc';
    var importExportTextarea = null;

    function getImportExportTextareaSafe() {
        if (importExportTextarea) return importExportTextarea;
        if (importExportPanel) {
            var textarea = importExportPanel.querySelector('textarea');
            if (textarea) {
                importExportTextarea = textarea;
                return textarea;
            }
        }
        return null;
    }

    function sanitizePositiveIntegerInputValue(rawValue) {
        return String(rawValue == null ? '' : rawValue).replace(/\D+/g, '');
    }

    function bindNumericOnlyPositionInput(inputEl) {
        if (!inputEl) return;

        inputEl.setAttribute('inputmode', 'numeric');
        inputEl.setAttribute('pattern', '[0-9]*');

        inputEl.addEventListener('input', function() {
            var sanitized = sanitizePositiveIntegerInputValue(inputEl.value);
            if (inputEl.value !== sanitized) inputEl.value = sanitized;
        });

        inputEl.addEventListener('wheel', function(e) {
            e.preventDefault();
        }, { passive: false });
    }

    function findDuplicateImportExportNames(names) {
        var seen = {};
        var duplicates = [];
        names.forEach(function(name) {
            if (seen[name]) {
                if (duplicates.indexOf(name) === -1) duplicates.push(name);
                return;
            }
            seen[name] = true;
        });
        return duplicates;
    }

    function serializeCurrentGalleryImportExportPayload() {
        return JSON.stringify({
            files: currentFiles.map(function(file) {
                return getCurrentFileDisplayName(file);
            })
        }, null, 2);
    }

    function hasImportExportFileExtension(name) {
        name = String(name || '').trim();
        return /\.[^./\\]+$/.test(name);
    }

    function validateImportExportFilesPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return { ok: false, message: 'JSON 根節點必須是物件' };
        }

        if (!Array.isArray(payload.files)) {
            return { ok: false, message: 'JSON 格式錯誤：缺少 files 陣列' };
        }

        if (!payload.files.every(function(name) { return typeof name === 'string'; })) {
            return { ok: false, message: 'files 陣列中的每一項都必須是字串' };
        }

        var importedNames = payload.files.map(function(name) {
            return String(name || '').trim();
        });

        if (importedNames.length !== currentFiles.length) {
            return {
                ok: false,
                message: '檔案數量不一致：目前圖庫為 ' + currentFiles.length + '，JSON 為 ' + importedNames.length
            };
        }

        for (var i = 0; i < importedNames.length; i++) {
            if (!importedNames[i]) {
                return { ok: false, message: '第 ' + (i + 1) + ' 個檔案名為空' };
            }
            if (!hasImportExportFileExtension(importedNames[i])) {
                return { ok: false, message: '第 ' + (i + 1) + ' 個檔案名缺少副檔名：' + importedNames[i] };
            }
        }

        return {
            ok: true,
            names: importedNames
        };
    }

    function applyImportedFileOrder(names) {
        currentFiles = currentFiles.map(function(file, index) {
            var normalized = normalizeGalleryFileListEntry(file);
            normalized.uploadName = names[index];
            return normalized;
        });
    }

    var ENABLE_FILE_SORT_TRACE = true;
    function traceFileSort(stage, payload) {
        if (!ENABLE_FILE_SORT_TRACE) return;
        try { _debug('[FileSortTrace]', stage, payload); } catch (e) {}
    }

    function ensureFileSortDebugProbeBound() {
        if (listContainer.__fifybujMouseSortDebugProbeBound) return;
        listContainer.__fifybujMouseSortDebugProbeBound = true;

        listContainer.addEventListener('pointerdown', function(e) {
            var row = e.target && e.target.closest ? e.target.closest('div[data-file-row="1"]') : null;
            if (!row) return;
            var isHandle = !!(e.target && e.target.closest && e.target.closest('[data-file-drag-handle="1"]'));
            traceFileSort('container_pointerdown', {
                button: e.button,
                pointerId: typeof e.pointerId === 'number' ? e.pointerId : null,
                pointerType: e.pointerType || '',
                rowIndex: row.getAttribute('data-file-index'),
                isHandle: isHandle,
                targetTag: e.target && e.target.tagName ? e.target.tagName : ''
            });
        }, true);

        listContainer.addEventListener('mousedown', function(e) {
            var row = e.target && e.target.closest ? e.target.closest('div[data-file-row="1"]') : null;
            if (!row) return;
            var isHandle = !!(e.target && e.target.closest && e.target.closest('[data-file-drag-handle="1"]'));
            traceFileSort('container_mousedown', {
                button: e.button,
                rowIndex: row.getAttribute('data-file-index'),
                isHandle: isHandle,
                targetTag: e.target && e.target.tagName ? e.target.tagName : ''
            });
        }, true);
    }

    function clearFileRowDropIndicators() {
        Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]')).forEach(function(r) {
            r.style.borderTop = '';
            r.style.borderBottom = '';
            r.__dropPosition = '';
        });
    }

    function captureFileRowRects() {
        var rects = new Map();
        Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]')).forEach(function(r) {
            rects.set(r, r.getBoundingClientRect());
        });
        return rects;
    }

    function playFileRowFlipAnimation(beforeRects) {
        var rows = Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]'));
        rows.forEach(function(r) {
            var before = beforeRects && beforeRects.get ? beforeRects.get(r) : null;
            if (!before) return;

            var after = r.getBoundingClientRect();
            var dy = before.top - after.top;
            if (!isFinite(dy) || Math.abs(dy) < 0.5) return;

            r.style.transition = 'none';
            r.style.transform = 'translateY(' + dy + 'px)';

            requestAnimationFrame(function() {
                r.style.transition = 'transform 0.16s ease';
                r.style.transform = '';
                setTimeout(function() {
                    r.style.transition = '';
                }, 180);
            });
        });
    }

    function resolveNearestFileRowByClientY(clientY) {
        var state = listContainer.__fifybujMouseSortState;
        var placeholder = state ? state.placeholderRow : null;

        var rows = Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]'))
            .filter(function(r) { return r !== placeholder; });

        if (rows.length === 0) return null;

        for (var i = 0; i < rows.length; i++) {
            var rect = rows[i].getBoundingClientRect();
            if (clientY <= rect.top + rect.height / 2) return rows[i];
        }
        return rows[rows.length - 1];
    }

    function updateFileRowDropIndicator(rowEl, clientY) {
        var state = listContainer.__fifybujMouseSortState;
        if (!state || !state.placeholderRow) return null;

        var placeholderRow = state.placeholderRow;
        var targetRow = rowEl || resolveNearestFileRowByClientY(clientY);

        if (!targetRow) return null;

        var rect = targetRow.getBoundingClientRect();
        var isBefore = clientY <= rect.top + rect.height / 2;
        var beforeRects = captureFileRowRects();

        if (isBefore) {
            if (targetRow !== placeholderRow.nextSibling) {
                listContainer.insertBefore(placeholderRow, targetRow);
            }
        } else {
            var next = targetRow.nextSibling;
            if (next !== placeholderRow) {
                if (next) listContainer.insertBefore(placeholderRow, next);
                else listContainer.appendChild(placeholderRow);
            }
        }

        playFileRowFlipAnimation(beforeRects);

        var orderedRows = Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]'));
        var prevTargetIndex = state.lastDropState && typeof state.lastDropState.targetIndex === 'number'
            ? state.lastDropState.targetIndex
            : null;
        var nextTargetIndex = orderedRows.indexOf(placeholderRow);

        state.lastDropState = {
            targetIndex: nextTargetIndex,
            didChange: true
        };

        if (prevTargetIndex !== nextTargetIndex) {
            traceFileSort('drop_indicator', {
                clientY: clientY,
                isBefore: isBefore,
                targetRowIndex: targetRow.getAttribute('data-file-index'),
                targetIndex: nextTargetIndex
            });
        }

        return state.lastDropState;
    }

    function cleanupFileMouseSortSession() {
        var state = listContainer.__fifybujMouseSortState;

        traceFileSort('cleanup:start', {
            hasState: !!state,
            sourceIndex: state ? state.sourceIndex : null,
            pointerId: state ? state.pointerId : null,
            lastDropState: state ? state.lastDropState : null
        });

        if (state) {
            if (state.moveHandler) listContainer.removeEventListener('pointermove', state.moveHandler, true);
            if (state.upHandler) listContainer.removeEventListener('pointerup', state.upHandler, true);
            if (state.cancelHandler) listContainer.removeEventListener('pointercancel', state.cancelHandler, true);
            if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler, true);
            if (state.blurHandler) window.removeEventListener('blur', state.blurHandler, true);
            if (state.rafId) cancelAnimationFrame(state.rafId);

            if (state.pointerId !== null && state.pointerId !== undefined && listContainer.releasePointerCapture) {
                try {
                    if (!listContainer.hasPointerCapture || listContainer.hasPointerCapture(state.pointerId)) {
                        listContainer.releasePointerCapture(state.pointerId);
                    }
                } catch (e) {}
            }

            if (state.ghostEl && state.ghostEl.parentNode) {
                state.ghostEl.parentNode.removeChild(state.ghostEl);
            }

            if (state.placeholderRow && state.placeholderRow.parentNode) {
                if (state.draggingRowEl && !state.draggingRowEl.parentNode) {
                    state.placeholderRow.parentNode.insertBefore(state.draggingRowEl, state.placeholderRow);
                }
                state.placeholderRow.parentNode.removeChild(state.placeholderRow);
            }
        }

        listContainer.__fifybujMouseSortState = null;
        document.body.classList.remove('is-dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        clearFileRowDropIndicators();
        dragSrcIndex = null;

        traceFileSort('cleanup:done', { done: true });
    }

    function beginFileMouseSort(rowEl, sourceIndex, startEvent) {
        if (!rowEl || !startEvent) {
            traceFileSort('begin:invalid_args', { hasRow: !!rowEl, hasEvent: !!startEvent });
            return;
        }
        sourceIndex = parseInt(sourceIndex, 10);
        if (!isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= currentFiles.length) {
            traceFileSort('begin:invalid_index', { sourceIndex: sourceIndex, fileCount: currentFiles.length });
            return;
        }

        cleanupFileMouseSortSession();

        dragSrcIndex = sourceIndex;
        traceFileSort('begin', {
            sourceIndex: sourceIndex,
            fileName: currentFiles[sourceIndex] ? (currentFiles[sourceIndex].name || currentFiles[sourceIndex].path || '') : '',
            clientX: startEvent.clientX,
            clientY: startEvent.clientY,
            pointerId: typeof startEvent.pointerId === 'number' ? startEvent.pointerId : null,
            pointerType: startEvent.pointerType || ''
        });

        var rowRect = rowEl.getBoundingClientRect();
        var parent = rowEl.parentNode;
        if (!parent) {
            traceFileSort('begin:no_parent', { sourceIndex: sourceIndex });
            return;
        }

        var placeholderRow = rowEl.cloneNode(true);
        placeholderRow.setAttribute('data-file-row', '1');
        placeholderRow.setAttribute('data-file-index', '-1');
        placeholderRow.style.opacity = '0.5';
        placeholderRow.style.pointerEvents = 'none';
        placeholderRow.style.boxShadow = 'inset 0 0 0 1px #5C0D12';
        Array.prototype.slice.call(placeholderRow.querySelectorAll('*')).forEach(function(el) {
            el.style.pointerEvents = 'none';
        });

        parent.insertBefore(placeholderRow, rowEl);
        parent.removeChild(rowEl);

        var state = {
            sourceIndex: sourceIndex,
            pointerId: typeof startEvent.pointerId === 'number' ? startEvent.pointerId : null,
            pointerType: startEvent.pointerType || 'mouse',
            placeholderRow: placeholderRow,
            draggingRowEl: rowEl,
            rowWidth: rowRect.width,
            rowHeight: rowRect.height,
            offsetX: startEvent.clientX - rowRect.left,
            offsetY: startEvent.clientY - rowRect.top,
            lastClientX: startEvent.clientX,
            lastClientY: startEvent.clientY,
            lastDropState: { targetIndex: sourceIndex, didChange: false },
            ghostEl: null,
            rafId: 0,
            framePending: false,
            moveHandler: null,
            upHandler: null,
            cancelHandler: null,
            keyHandler: null,
            blurHandler: null,
            loggedFirstMove: false
        };

        listContainer.__fifybujMouseSortState = state;

        if (state.pointerId !== null && listContainer.setPointerCapture) {
            try {
                listContainer.setPointerCapture(state.pointerId);
                traceFileSort('pointer_capture_set', {
                    sourceIndex: sourceIndex,
                    pointerId: state.pointerId
                });
            } catch (captureErr) {
                traceFileSort('pointer_capture_error', {
                    sourceIndex: sourceIndex,
                    pointerId: state.pointerId,
                    message: captureErr && (captureErr.message || String(captureErr))
                });
            }
        }

        function ensureGhost(state, moveEvent) {
            if (state.ghostEl) return state.ghostEl;
            document.body.classList.add('is-dragging');

            var ghost = state.draggingRowEl.cloneNode(true);
            ghost.style.position = 'fixed';
            ghost.style.left = '0px';
            ghost.style.top = '0px';
            ghost.style.width = state.rowWidth + 'px';
            ghost.style.height = state.rowHeight + 'px';
            ghost.style.zIndex = '999999';
            ghost.style.pointerEvents = 'none';
            ghost.style.opacity = '0.92';
            ghost.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
            ghost.style.cursor = 'grabbing';
            Array.prototype.slice.call(ghost.querySelectorAll('*')).forEach(function(el) {
                el.style.pointerEvents = 'none';
            });

            document.body.appendChild(ghost);
            state.ghostEl = ghost;

            traceFileSort('ghost_created', {
                sourceIndex: state.sourceIndex,
                width: state.rowWidth,
                height: state.rowHeight,
                clientX: moveEvent && moveEvent.clientX,
                clientY: moveEvent && moveEvent.clientY
            });

            return ghost;
        }

        function moveGhost(state, moveEvent) {
            var ghost = ensureGhost(state, moveEvent);
            if (!ghost) return;
            ghost.style.left = (moveEvent.clientX - state.offsetX) + 'px';
            ghost.style.top = (moveEvent.clientY - state.offsetY) + 'px';
        }

        function finishSort(shouldCommit, reason) {
            var active = listContainer.__fifybujMouseSortState;
            if (!active) return;

            var targetIndex = active.lastDropState && typeof active.lastDropState.targetIndex === 'number'
                ? active.lastDropState.targetIndex
                : active.sourceIndex;

            if (targetIndex < 0) targetIndex = 0;
            if (targetIndex > currentFiles.length - 1) targetIndex = currentFiles.length - 1;

            traceFileSort('finish', {
                reason: reason || '',
                shouldCommit: shouldCommit,
                sourceIndex: active.sourceIndex,
                targetIndex: targetIndex,
                changed: targetIndex !== active.sourceIndex
            });

            if (shouldCommit && targetIndex !== active.sourceIndex) {
                var moved = currentFiles.splice(active.sourceIndex, 1)[0];
                if (moved) {
                    if (targetIndex > currentFiles.length) targetIndex = currentFiles.length;
                    currentFiles.splice(targetIndex, 0, moved);
                }
            }

            cleanupFileMouseSortSession();
            renderFileList();
            if (currentSubPanel === 'foldermanager') renderFolderManager();
            if (currentSubPanel === 'filerename') renderRenamerList();
        }

        state.moveHandler = function(moveEvent) {
            var active = listContainer.__fifybujMouseSortState;
            if (!active) return;
            if (active.pointerId !== null && typeof moveEvent.pointerId === 'number' && moveEvent.pointerId !== active.pointerId) return;

            moveEvent.preventDefault();
            moveEvent.stopPropagation();

            active.lastClientX = moveEvent.clientX;
            active.lastClientY = moveEvent.clientY;

            if (!active.loggedFirstMove) {
                active.loggedFirstMove = true;
                traceFileSort('pointermove:first', {
                    sourceIndex: active.sourceIndex,
                    clientX: moveEvent.clientX,
                    clientY: moveEvent.clientY,
                    pointerId: moveEvent.pointerId
                });
            }

            moveGhost(active, moveEvent);

            if (active.framePending) return;
            active.framePending = true;
            active.rafId = requestAnimationFrame(function() {
                active.framePending = false;
                if (listContainer.__fifybujMouseSortState !== active) return;
                updateFileRowDropIndicator(null, active.lastClientY);
            });
        };

        state.upHandler = function(upEvent) {
            if (state.pointerId !== null && typeof upEvent.pointerId === 'number' && upEvent.pointerId !== state.pointerId) return;
            upEvent.preventDefault();
            upEvent.stopPropagation();
            traceFileSort('pointerup', {
                sourceIndex: state.sourceIndex,
                clientY: upEvent.clientY,
                pointerId: upEvent.pointerId
            });
            finishSort(true, 'pointerup');
        };

        state.cancelHandler = function(cancelEvent) {
            if (state.pointerId !== null && typeof cancelEvent.pointerId === 'number' && cancelEvent.pointerId !== state.pointerId) return;
            cancelEvent.preventDefault();
            cancelEvent.stopPropagation();
            traceFileSort('pointercancel', {
                sourceIndex: state.sourceIndex,
                pointerId: cancelEvent.pointerId
            });
            finishSort(false, 'pointercancel');
        };

        state.keyHandler = function(keyEvent) {
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                traceFileSort('cancel:escape', { sourceIndex: state.sourceIndex });
                finishSort(false, 'escape');
            }
        };

        state.blurHandler = function() {
            traceFileSort('cancel:window_blur', { sourceIndex: state.sourceIndex });
            finishSort(false, 'window_blur');
        };

        listContainer.addEventListener('pointermove', state.moveHandler, true);
        listContainer.addEventListener('pointerup', state.upHandler, true);
        listContainer.addEventListener('pointercancel', state.cancelHandler, true);
        document.addEventListener('keydown', state.keyHandler, true);
        window.addEventListener('blur', state.blurHandler, true);

        ensureGhost(state, startEvent);
        moveGhost(state, startEvent);
        updateFileRowDropIndicator(null, startEvent.clientY);
    }

    function getActiveFileComparator() {
        var baseCompare = currentSortMethod === 'lexical' ? lexicalCompare : naturalCompare;
        return function(a, b) {
            var pa = a.path || a.name || '';
            var pb = b.path || b.name || '';
            var result = baseCompare(pa, pb);
            return currentSortDirection === 'desc' ? -result : result;
        };
    }

    function applyFileSortButtonState() {
        var isAsc = currentSortDirection === 'asc';
        sortAscBtn.style.backgroundColor = isAsc ? '#5C0D12' : '#E0DED3';
        sortAscBtn.style.color = isAsc ? '#FFFFFF' : '#5C0D12';
        sortDescBtn.style.backgroundColor = isAsc ? '#E0DED3' : '#5C0D12';
        sortDescBtn.style.color = isAsc ? '#5C0D12' : '#FFFFFF';
    }

    function applyRenamerSortButtonState() {
        var isAsc = renamerCurrentSortDirection === 'asc';
        renamerSortAscBtn.style.backgroundColor = isAsc ? '#5C0D12' : '#E0DED3';
        renamerSortAscBtn.style.color = isAsc ? '#FFFFFF' : '#5C0D12';
        renamerSortDescBtn.style.backgroundColor = isAsc ? '#E0DED3' : '#5C0D12';
        renamerSortDescBtn.style.color = isAsc ? '#5C0D12' : '#FFFFFF';
    }

    function sortCurrentFilesAndRender(skipRender) {
        currentFiles.sort(getActiveFileComparator());
        if (skipRender) return;
        renderFileList();
        if (currentSubPanel === 'foldermanager') renderFolderManager();
        if (currentSubPanel === 'filerename') renderRenamerList();
    }

    function loadCurrentGalleryFilesSorted(galleryId) {
        if (!galleryId) {
            currentFiles = [];
            pendingDeletedGalleryFileKeys = [];
            currentSortMethod = 'natural';
            currentSortDirection = 'asc';
            sortingSelect.value = 'natural';
            applyFileSortButtonState();
            return;
        }
        pendingDeletedGalleryFileKeys = [];
        var data = readGalleryFileListById(galleryId);
        currentFiles = data.files.slice();
        currentSortMethod = 'natural';
        currentSortDirection = 'asc';
        sortingSelect.value = 'natural';
        sortCurrentFilesAndRender(true);
        applyFileSortButtonState();
    }

    function writeCurrentGalleryFiles() {
        if (!currentGalleryId) return;
        var currentData = readGalleryFileListById(currentGalleryId);
        writeGalleryFileListById(currentGalleryId, currentData.folderName, currentFiles);
        pendingDeletedGalleryFileKeys = [];
    }

    function restoreCurrentGalleryFilesFromSaved() {
        if (!currentGalleryId) {
            currentFiles = [];
            return;
        }
        var data = readGalleryFileListById(currentGalleryId);
        currentFiles = Array.isArray(data.files) ? data.files.slice() : [];
        pendingDeletedGalleryFileKeys = [];
    }

    function syncRenamerInputsToCurrentFiles() {
        Array.prototype.slice.call(renamerListContainer.querySelectorAll('input[data-renamer-name-input="1"]')).forEach(function(input) {
            var idx = parseInt(input.getAttribute('data-renamer-index'), 10);
            if (!isFinite(idx) || idx < 0 || idx >= currentFiles.length) return;
            currentFiles[idx] = normalizeGalleryFileListEntry(currentFiles[idx]);
            currentFiles[idx].uploadName = String(input.value || '');
        });
    }

    function getCurrentFileDisplayName(file) {
        if (!file) return '';
        if (file.uploadName) return String(file.uploadName);
        if (file.name) return String(file.name);
        if (file.originalName) return String(file.originalName);
        if (file.path) return String(getGalleryFileLeafNameFromPath(file.path) || file.path);
        return '';
    }

    function sortCurrentFilesForRenamer(direction) {
        syncRenamerInputsToCurrentFiles();
        currentFiles.sort(function(a, b) {
            var result = naturalCompare(getCurrentFileDisplayName(a), getCurrentFileDisplayName(b));
            return direction === 'desc' ? -result : result;
        });
    }

    function refreshAllFilePanels() {
        renderFileList();
        renderFolderManager();
        renderRenamerList();
        renderImportExportPanel();
    }

    function getGalleryFileIdentity(file) {
        return String((file && (file.path || file.name)) || '');
    }

    function getCheckedGalleryFileEntries() {
        var entries = [];
        Array.prototype.slice.call(listContainer.querySelectorAll('div[data-file-row="1"]')).forEach(function(row) {
            var cb = row.querySelector('input[type="checkbox"]');
            var idx = parseInt(row.getAttribute('data-file-index'), 10);
            if (!cb || !cb.checked) return;
            if (!isFinite(idx) || idx < 0 || idx >= currentFiles.length) return;
            entries.push({ index: idx, file: currentFiles[idx] });
        });
        return entries;
    }

    function rememberPendingDeletedGalleryFileEntries(entries) {
        toArray(entries).forEach(function(entry) {
            var key = getGalleryFileIdentity(entry && entry.file);
            if (!key) return;
            if (pendingDeletedGalleryFileKeys.indexOf(key) === -1) pendingDeletedGalleryFileKeys.push(key);
        });
    }

    function saveCheckedGalleryFileChanges() {
        if (!currentGalleryId) return false;

        var checkedEntries = getCheckedGalleryFileEntries();
        if (!checkedEntries.length && pendingDeletedGalleryFileKeys.length === 0) return false;

        syncRenamerInputsToCurrentFiles();

        var currentData = readGalleryFileListById(currentGalleryId);
        var savedFiles = Array.isArray(currentData.files) ? currentData.files.slice() : [];
        var deletedSet = {};
        pendingDeletedGalleryFileKeys.forEach(function(key) {
            deletedSet[key] = true;
        });

        if (pendingDeletedGalleryFileKeys.length > 0) {
            savedFiles = savedFiles.filter(function(file) {
                return !deletedSet[getGalleryFileIdentity(file)];
            });
        }

        var selectedSet = {};
        checkedEntries.forEach(function(entry) {
            selectedSet[getGalleryFileIdentity(entry.file)] = true;
        });

        var selectedPositions = [];
        savedFiles.forEach(function(file, idx) {
            if (selectedSet[getGalleryFileIdentity(file)]) selectedPositions.push(idx);
        });

        var currentSelectedFiles = currentFiles.filter(function(file) {
            return !!selectedSet[getGalleryFileIdentity(file)];
        });

        selectedPositions.forEach(function(pos, idx) {
            if (idx < currentSelectedFiles.length) savedFiles[pos] = currentSelectedFiles[idx];
        });

        writeGalleryFileListById(currentGalleryId, currentData.folderName, savedFiles);
        currentFiles = savedFiles.slice();
        pendingDeletedGalleryFileKeys = [];
        return true;
    }

    function copyFileTitleWithFeedback(btn, text) {
        var restoreText = _getFeedbackElementText(btn) || '複製標題';
        text = String(text == null ? '' : text);

        function handleSuccess() {
            flashButtonSavedState(btn, '✓', restoreText, 1000);
        }

        function handleError() {
            flashColoredErrorState(btn, 'Fail', restoreText, _getConfirmFeedbackSettingsSafe().delayMs);
        }

        if (!text) {
            handleError();
            return;
        }

        function fallbackCopy() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                ta.style.top = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                var ok = false;
                try { ok = document.execCommand('copy'); } catch (e) {}
                document.body.removeChild(ta);
                if (ok) handleSuccess();
                else handleError();
            } catch (e2) {
                handleError();
            }
        }

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                    handleSuccess();
                }).catch(function() {
                    fallbackCopy();
                });
                return;
            }
        } catch (e3) {}

        fallbackCopy();
    }

    function shouldCopyGalleryFolderManagerFileExtension() {
        var settings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe() || {});
        return settings.galleryFolderManagerCopyWithExtension !== false;
    }

    function getGalleryFolderManagerCopyText(file) {
        var text = getCurrentFileDisplayName(file);
        if (shouldCopyGalleryFolderManagerFileExtension()) return text;
        var lastDot = text.lastIndexOf('.');
        if (lastDot <= 0) return text;
        return text.slice(0, lastDot);
    }

    function switchTab(tab) {
        currentSubPanel = tab;
        var tabs = [
            { el: fileListTab, panel: fileListPanel, name: 'filelist' },
            { el: folderManagerTab, panel: folderManagerPanel, name: 'foldermanager' },
            { el: fileRenamerTab, panel: fileRenamerPanel, name: 'filerename' },
            { el: importExportTab, panel: importExportPanel, name: 'importexport' }
        ];
        tabs.forEach(function(t) {
            var active = t.name === tab;
            t.el.style.backgroundColor = active ? '#5C0D12' : '#E3E0D1';
            t.el.style.color = active ? '#FFFFFF' : '#5C0D12';
            t.panel.style.display = active ? 'block' : 'none';
        });
        if (tab === 'foldermanager') renderFolderManager();
        if (tab === 'filerename') {
            renderRenamerList();
            applyRenamerSortButtonState();
        }
        if (tab === 'importexport') renderImportExportPanel();
    }

    fileListTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('filelist'); });
    folderManagerTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('foldermanager'); });
    fileRenamerTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('filerename'); });
    importExportTab.addEventListener('click', function(e) { e.preventDefault(); switchTab('importexport'); });

    function renderFileList() {
        ensureFileSortDebugProbeBound();
        while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
        if (currentFiles.length === 0) {
            var emptyMsg = document.createElement('div');
            emptyMsg.textContent = '無文件';
            emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
            listContainer.appendChild(emptyMsg);
            return;
        }

        function clearFileRowDropIndicators() {
            listContainer.querySelectorAll('div[data-file-row="1"]').forEach(function(r) {
                r.style.borderTop = '';
                r.style.borderBottom = '';
                r.__dropPosition = '';
            });
        }

        function clearPreviewBtnErrorTimer(btn) {
            if (!btn || !btn.__previewErrorTimer) return;
            clearTimeout(btn.__previewErrorTimer);
            btn.__previewErrorTimer = null;
        }

        function setPreviewBtnDefaultStyle(btn) {
            if (!btn) return;
            clearPreviewBtnErrorTimer(btn);
            btn.style.backgroundColor = '#E0DED3';
            btn.style.color = '#5C0D12';
            btn.style.borderColor = '#5C0D12';
            btn.style.outline = 'none';
            btn.style.boxShadow = 'none';
        }

        function setPreviewBtnActiveStyle(btn) {
            if (!btn) return;
            clearPreviewBtnErrorTimer(btn);
            btn.style.backgroundColor = '#5C0D12';
            btn.style.color = '#FFFFFF';
            btn.style.borderColor = '#5C0D12';
            btn.style.outline = 'none';
            btn.style.boxShadow = 'none';
        }

        function applyPreviewBtnErrorFeedback(btn) {
            if (!btn) return;
            var feedbackSettings = _getConfirmFeedbackSettingsSafe();
            var errorColor = feedbackSettings.errorColor || 'rgb(255,0,0)';
            var delayMs = (typeof feedbackSettings.delayMs === 'number' && feedbackSettings.delayMs >= 0) ? feedbackSettings.delayMs : 1000;

            clearPreviewBtnErrorTimer(btn);
            try { btn.blur(); } catch (e) {}
            btn.classList.remove('preview-btn-active');
            btn.style.backgroundColor = errorColor;
            btn.style.color = '#FFFFFF';
            btn.style.borderColor = errorColor;
            btn.style.outline = 'none';
            btn.style.boxShadow = 'none';

            btn.__previewErrorTimer = setTimeout(function() {
                btn.__previewErrorTimer = null;
                if (btn.classList.contains('preview-btn-active')) return;
                btn.style.backgroundColor = '#E0DED3';
                btn.style.color = '#5C0D12';
                btn.style.borderColor = '#5C0D12';
                btn.style.outline = 'none';
                btn.style.boxShadow = 'none';
            }, delayMs);
        }

        function setPreviewBtnErrorStyle(btn) {
            if (!btn) return;
            applyPreviewBtnErrorFeedback(btn);
        }

        function handlePreviewFailure(btn, level, message, payload) {
            if (level === 'warn') {
                if (payload === undefined) warnLog('Preview', message);
                else warnLog('Preview', message, payload);
            } else {
                if (payload === undefined) errorLog('Preview', message);
                else errorLog('Preview', message, payload);
            }
            setPreviewBtnErrorStyle(btn);
        }

        function bindRowDropTarget(targetEl, rowEl) {
            if (!targetEl || !rowEl) return;

            function showDropIndicator(e) {
                if (dragSrcIndex === null) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

                var rect = rowEl.getBoundingClientRect();
                var placeAfter = e.clientY > rect.top + rect.height / 2;

                clearFileRowDropIndicators();
                rowEl.__dropPosition = placeAfter ? 'after' : 'before';
                rowEl.style.borderTop = placeAfter ? '' : '2px solid #5C0D12';
                rowEl.style.borderBottom = placeAfter ? '2px solid #5C0D12' : '';
            }

            targetEl.addEventListener('dragenter', showDropIndicator);
            targetEl.addEventListener('dragover', showDropIndicator);
            targetEl.addEventListener('drop', function(e) {
                if (dragSrcIndex === null) return;
                e.preventDefault();
                e.stopPropagation();

                var targetIndex = parseInt(rowEl.getAttribute('data-file-index'), 10);
                if (isNaN(targetIndex)) {
                    clearFileRowDropIndicators();
                    dragSrcIndex = null;
                    return;
                }

                if (rowEl.__dropPosition === 'after') targetIndex += 1;

                var sourceIndex = dragSrcIndex;
                if (sourceIndex < targetIndex) targetIndex--;

                clearFileRowDropIndicators();

                if (targetIndex === sourceIndex) {
                    dragSrcIndex = null;
                    return;
                }

                var moved = currentFiles.splice(sourceIndex, 1)[0];
                if (!moved) {
                    dragSrcIndex = null;
                    return;
                }

                if (targetIndex < 0) targetIndex = 0;
                if (targetIndex > currentFiles.length) targetIndex = currentFiles.length;

                currentFiles.splice(targetIndex, 0, moved);

                dragSrcIndex = null;
                renderFileList();
            });
        }

        currentFiles.forEach(function(file, index) {
            var row = document.createElement('div');
            row.setAttribute('data-file-row', '1');
            row.setAttribute('data-file-index', String(index));
            row.draggable = false;
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209); cursor: default; transition: transform 0.16s ease, background-color 0.12s ease, opacity 0.12s ease, box-shadow 0.12s ease; user-select: none; -webkit-user-select: none;';

            var checkBox = document.createElement('input');
            checkBox.type = 'checkbox';
            checkBox.draggable = false;
            checkBox.style.cssText = 'margin: 0; width: 16px; height: 16px; flex-shrink: 0; accent-color: #5C0D12; align-self: center; display: block; position: relative; top: 0;';
            row.appendChild(checkBox);

            var dragHandleWrap = document.createElement('div');
            dragHandleWrap.style.cssText = 'display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: grab; user-select: none; -webkit-user-drag: none; touch-action: none;';
            dragHandleWrap.draggable = false;
            dragHandleWrap.title = '拖曳排序';
            dragHandleWrap.setAttribute('data-file-drag-handle', '1');

            dragHandleWrap.addEventListener('dragstart', function(e) { e.preventDefault(); });
            dragHandleWrap.addEventListener('pointerdown', function(e) {
                traceFileSort('handle_pointerdown', {
                    index: index,
                    button: e.button,
                    pointerId: typeof e.pointerId === 'number' ? e.pointerId : null,
                    pointerType: e.pointerType || '',
                    fileName: file.name || file.path || '',
                    targetTag: e.target && e.target.tagName ? e.target.tagName : ''
                });

                if ((e.pointerType === 'mouse' || !e.pointerType) && e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                beginFileMouseSort(row, index, e);
            });

            var numSpan = document.createElement('span');
            numSpan.textContent = (index + 1) + '.';
            numSpan.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold; min-width: 30px; flex-shrink: 0; user-select: none;';
            dragHandleWrap.appendChild(numSpan);

            var dragHandle = document.createElement('span');
            dragHandle.textContent = getCurrentFileDisplayName(file);
            dragHandle.style.cssText = 'font-size: 9pt; flex: 1; min-width: 0; word-break: break-all; user-select: none;';
            dragHandleWrap.appendChild(dragHandle);

            row.appendChild(dragHandleWrap);

            var copyTitleBtn = document.createElement('button');
            copyTitleBtn.textContent = 'COPY';
            copyTitleBtn.draggable = false;
            applyPageToneBtnStyle(copyTitleBtn, 'height: 20px;padding: 0 6px;flex-shrink: 0;font-size: 9pt;outline: none;box-shadow: none;user-select: none;white-space: nowrap;');
            copyTitleBtn.addEventListener('pointerdown', function(e) {
                e.stopPropagation();
            });
            copyTitleBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                copyFileTitleWithFeedback(copyTitleBtn, getGalleryFolderManagerCopyText(file));
            });
            row.appendChild(copyTitleBtn);

            var previewBtn = document.createElement('button');
            previewBtn.textContent = '預覧';
            previewBtn.draggable = false;
            applyPageToneBtnStyle(previewBtn, 'width: 36px;height: 20px;padding: 0;flex-shrink: 0;font-size: 9pt;outline: none;box-shadow: none;user-select: none;');
            previewBtn.addEventListener('pointerdown', function(e) {
                e.stopPropagation();
            });
            setPreviewBtnDefaultStyle(previewBtn);

            (function(f, btn) {
                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var existingOverlay = document.getElementById('file-preview-overlay');
                    var existingActiveBtn = document.querySelector('.preview-btn-active');
                    if (existingActiveBtn && existingActiveBtn !== btn) {
                        setPreviewBtnDefaultStyle(existingActiveBtn);
                        existingActiveBtn.classList.remove('preview-btn-active');
                    }
                    if (existingOverlay) { existingOverlay.remove(); }

                    setPreviewBtnActiveStyle(btn);
                    btn.classList.add('preview-btn-active');

                    var fileListData = currentGalleryId ? readGalleryFileListById(currentGalleryId) : {
                        folderName: null,
                        sourceType: null,
                        authorizedRootId: null,
                        files: []
                    };
                    if (fileListData.sourceType !== 'folder') {
                        handlePreviewFailure(btn, 'warn', '僅文件夾來源支援預覧', f.name || f.path);
                        return;
                    }

                    var sourcePath = String((f && (f.path || f.originalPath || f.name)) || '');
                    if (!sourcePath) {
                        handlePreviewFailure(btn, 'warn', '無法解析檔案路徑', f.name || f.path);
                        return;
                    }

                    var maxW = currentSettings.previewMaxWidth || 800;
                    var maxH = currentSettings.previewMaxHeight || 800;
                    getAuthorizedRootHandleByIdOrLegacy(fileListData.authorizedRootId).then(function(rootHandle) {
                        if (!rootHandle) {
                            handlePreviewFailure(btn, 'warn', '無已授權文件夾 handle');
                            return;
                        }
                        return requestReadPermissionIfNeeded(rootHandle).then(function(canRead) {
                            if (!canRead) {
                                handlePreviewFailure(btn, 'warn', '無讀取權限');
                                return;
                            }
                            return resolveFileObjectFromDirectoryHandlePath(rootHandle, sourcePath).then(function(fileObj) {
                                var url = URL.createObjectURL(fileObj);
                                var overlay = document.createElement('div');
                                overlay.id = 'file-preview-overlay';
                                overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); z-index: 99999; display: flex; align-items: center; justify-content: center;';
                                var imgBox = document.createElement('div');
                                imgBox.style.cssText = 'background: #1a1a1a; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: ' + maxW + 'px;';
                                var img = document.createElement('img');
                                img.src = url;
                                img.style.cssText = 'max-width: ' + maxW + 'px; max-height: ' + maxH + 'px; object-fit: contain; border-radius: 3px; display: block;';
                                img.onerror = function() { warnLog('Preview', '圖片載入失敗', f.name || f.path); };
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
                                    setPreviewBtnDefaultStyle(btn);
                                    btn.classList.remove('preview-btn-active');
                                    document.removeEventListener('keydown', escHandler);
                                }

                                function escHandler(ev) {
                                    if (ev.key === 'Escape') closePreview();
                                }

                                document.addEventListener('keydown', escHandler);
                                overlay.addEventListener('click', function(ev) {
                                    if (ev.target === overlay) closePreview();
                                });
                            }).catch(function(err) {
                                handlePreviewFailure(btn, 'warn', '無法解析檔案', { path: sourcePath, message: err.message });
                            });
                        });
                    }).catch(function(err) {
                        handlePreviewFailure(btn, 'error', '錯誤', { name: err.name, message: err.message, error: err });
                    });
                });
            })(file, previewBtn);
            row.appendChild(previewBtn);

            var posInput = document.createElement('input');
            posInput.type = 'text';
            posInput.draggable = false;
            posInput.value = String(index + 1);
            posInput.style.cssText = 'width: 44px; border: 1px solid #5C0D12; background-color: rgb(227,224,209); font-size: 9pt; padding: 0 2px; height: 20px; box-sizing: border-box; flex-shrink: 0; text-align: center; user-select: text; -webkit-user-select: text;';
            bindNumericOnlyPositionInput(posInput);
            posInput.addEventListener('blur', function() {
                var sanitized = sanitizePositiveIntegerInputValue(posInput.value);
                if (!sanitized || parseInt(sanitized, 10) < 1) {
                    posInput.value = String(index + 1);
                    return;
                }
                posInput.value = sanitized;
            });
            posInput.addEventListener('keydown', function(e) {
                if (e.key !== 'Enter') return;
                var sanitized = sanitizePositiveIntegerInputValue(posInput.value);
                var target = parseInt(sanitized, 10) - 1;
                if (!sanitized || isNaN(target) || target < 0 || target >= currentFiles.length || target === index) {
                    posInput.value = String(index + 1);
                    return;
                }
                var moved = currentFiles.splice(index, 1)[0];
                currentFiles.splice(target, 0, moved);
                renderFileList();
            });
            row.appendChild(posInput);

            var upBtn = document.createElement('button');
            upBtn.textContent = '↑';
            upBtn.draggable = false;
            applyPageToneBtnStyle(upBtn, 'width: 22px;height: 20px;padding: 0;flex-shrink: 0;font-size: 9pt;');
            if (index === 0) { upBtn.style.opacity = '0.3'; upBtn.style.cursor = 'default'; }
            upBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === 0) return;
                var tmp = currentFiles[index];
                currentFiles[index] = currentFiles[index - 1];
                currentFiles[index - 1] = tmp;
                renderFileList();
            });
            row.appendChild(upBtn);

            var downBtn = document.createElement('button');
            downBtn.textContent = '↓';
            downBtn.draggable = false;
            applyPageToneBtnStyle(downBtn, 'width: 22px;height: 20px;padding: 0;flex-shrink: 0;font-size: 9pt;');
            if (index === currentFiles.length - 1) { downBtn.style.opacity = '0.3'; downBtn.style.cursor = 'default'; }
            downBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === currentFiles.length - 1) return;
                var tmp2 = currentFiles[index];
                currentFiles[index] = currentFiles[index + 1];
                currentFiles[index + 1] = tmp2;
                renderFileList();
            });
            row.appendChild(downBtn);

            var delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.draggable = false;
            applyPageToneBtnStyle(delBtn, 'width: 22px;height: 20px;padding: 0;flex-shrink: 0;font-size: 9pt;');
            delBtn.addEventListener('click', function(e) {
                e.preventDefault();
                currentFiles.splice(index, 1);
                renderFileList();
                if (currentSubPanel === 'foldermanager') renderFolderManager();
                if (currentSubPanel === 'filerename') renderRenamerList();
            });
            row.appendChild(delBtn);

            listContainer.appendChild(row);
        });
    }

    function renderFolderManager() {
        while (folderListContainer.firstChild) folderListContainer.removeChild(folderListContainer.firstChild);
        if (currentFiles.length === 0) {
            var emptyMsg = document.createElement('div');
            emptyMsg.textContent = '無文件夾';
            emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
            folderListContainer.appendChild(emptyMsg);
            return;
        }

        var galleryData = currentGalleryId ? readGalleryFileListById(currentGalleryId) : {
            folderName: null,
            sourceType: null,
            sourceLabel: null,
            rootSources: []
        };
        var rootSources = normalizeGalleryRootSources(galleryData.rootSources, galleryData.sourceType, galleryData.sourceLabel);
        var rootIconMap = {};
        rootSources.forEach(function(item) {
            if (!rootIconMap[item.name]) rootIconMap[item.name] = item.type;
        });

        function getFolderManagerDisplayPath(fileEntry) {
            var normalized = normalizeGalleryFileListEntry(fileEntry);
            var path = String(normalized.path || normalized.originalPath || normalized.originalName || '').trim();
            if (!path) return '';

            if (rootSources.length === 1) {
                var rootName = String(rootSources[0].name || '').trim();
                if (rootName && path !== rootName && path.indexOf(rootName + '/') !== 0) {
                    return rootName + '/' + path;
                }
            }

            return path;
        }

        var folderTree = {};
        currentFiles.forEach(function(file) {
            var displayPath = getFolderManagerDisplayPath(file);
            var parts = displayPath.split('/').filter(function(part) { return !!part; });
            if (parts.length <= 1) return;
            var dirs = parts.slice(0, -1);
            var node = folderTree;
            dirs.forEach(function(dir) {
                if (!node[dir]) node[dir] = {};
                node = node[dir];
            });
        });

        function renderNode(node, path, depth) {
            Object.keys(node).sort(function(a, b) { return naturalCompare(a, b); }).forEach(function(key) {
                var fullPath = path ? path + '/' + key : key;
                var row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209);';

                var indent = document.createElement('span');
                indent.style.cssText = 'display: inline-block; width: ' + (depth * 16) + 'px; flex-shrink: 0;';
                row.appendChild(indent);

                var checkBox = document.createElement('input');
                checkBox.type = 'checkbox';
                checkBox.style.cssText = 'margin: 0; width: 16px; height: 16px; flex-shrink: 0; accent-color: #5C0D12; align-self: center; display: block; position: relative; top: 0;';
                row.appendChild(checkBox);

                if (depth === 0 && rootIconMap[key]) {
                    var sourceIcon = document.createElement('span');
                    sourceIcon.textContent = rootIconMap[key] === 'folder' ? '📁' : '📦';
                    sourceIcon.style.cssText = 'font-size: 11pt; line-height: 1; flex-shrink: 0;';
                    row.appendChild(sourceIcon);
                }

                var nameSpan = document.createElement('span');
                nameSpan.textContent = key + '/';
                nameSpan.style.cssText = 'font-size: 9pt; flex: 1; color: #333; font-weight: ' + (depth === 0 ? 'bold' : 'normal') + ';';
                row.appendChild(nameSpan);

                var delBtn = document.createElement('button');
                delBtn.textContent = '✕';
                applyPageToneBtnStyle(delBtn, 'width: 22px;height: 20px;padding: 0;flex-shrink: 0;font-size: 9pt;');
                delBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    currentFiles = currentFiles.filter(function(f) {
                        var p = getFolderManagerDisplayPath(f);
                        return !p.startsWith(fullPath + '/') && p !== fullPath;
                    });
                    renderFolderManager();
                    renderFileList();
                    if (currentSubPanel === 'filerename') renderRenamerList();
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
        if (currentFiles.length === 0) {
            var emptyMsg = document.createElement('div');
            emptyMsg.textContent = '無文件';
            emptyMsg.style.cssText = 'padding: 10px; font-size: 9pt; color: #666; text-align: center;';
            renamerListContainer.appendChild(emptyMsg);
            return;
        }

        currentFiles.forEach(function(file, index) {
            var row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid rgba(92,13,18,0.15); background-color: rgb(227,224,209);';

            var checkBox = document.createElement('input');
            checkBox.type = 'checkbox';
            checkBox.style.cssText = 'margin: 0; width: 16px; height: 16px; flex-shrink: 0; accent-color: #5C0D12; align-self: center; display: block; position: relative; top: 0;';
            row.appendChild(checkBox);

            var numSpan = document.createElement('span');
            numSpan.textContent = (index + 1) + '.';
            numSpan.style.cssText = 'font-size: 9pt; color: #5C0D12; font-weight: bold; min-width: 30px; flex-shrink: 0;';
            row.appendChild(numSpan);

            var nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = getCurrentFileDisplayName(file);
            nameInput.setAttribute('data-renamer-name-input', '1');
            nameInput.setAttribute('data-renamer-index', String(index));
            nameInput.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: rgb(227,224,209); font-size: 9pt; padding: 0 4px; height: 20px; box-sizing: border-box; user-select: text; -webkit-user-select: text;';
            nameInput.addEventListener('input', function() {
                currentFiles[index] = normalizeGalleryFileListEntry(currentFiles[index]);
                currentFiles[index].uploadName = nameInput.value;
            });
            nameInput.addEventListener('change', function() {
                currentFiles[index] = normalizeGalleryFileListEntry(currentFiles[index]);
                currentFiles[index].uploadName = nameInput.value;
            });
            row.appendChild(nameInput);

            renamerListContainer.appendChild(row);
        });
    }

    function renderImportExportPanel() {
        var textarea = getImportExportTextareaSafe();
        if (!textarea) return;

        if (!currentGalleryId) {
            textarea.value = '';
            textarea.placeholder = '請先在上方選擇圖庫';
            return;
        }

        if (!String(textarea.value || '').trim()) {
            textarea.placeholder = '點擊「導出」生成 {"files":[...]}，或貼上 JSON 後點擊「導入」';
        }
    }



    sortAscBtn.addEventListener('click', function(e) {
        e.preventDefault();
        currentSortDirection = 'asc';
        sortCurrentFilesAndRender(false);
        applyFileSortButtonState();
    });

    sortDescBtn.addEventListener('click', function(e) {
        e.preventDefault();
        currentSortDirection = 'desc';
        sortCurrentFilesAndRender(false);
        applyFileSortButtonState();
    });

    sortGoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        currentSortMethod = sortingSelect.value;
        sortCurrentFilesAndRender(false);
        applyFileSortButtonState();
    });

    actionGoBtn.addEventListener('click', function(e) {
        e.preventDefault();

        if (actionSelect.value === 'save') {
            var checkedEntriesToSave = getCheckedGalleryFileEntries();
            var pendingDeletedCount = pendingDeletedGalleryFileKeys.length;
            if (!checkedEntriesToSave.length && pendingDeletedCount === 0) {
                flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
                return;
            }
            if (saveCheckedGalleryFileChanges()) {
                opLog('保存勾選 Gallery File', {
                    galleryId: currentGalleryId,
                    count: checkedEntriesToSave.length,
                    pendingDeleted: pendingDeletedCount
                });
                refreshAllFilePanels();
                flashButtonSavedState(actionGoBtn, '✓', 'GO', 1000);
            } else {
                flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
            }
            return;
        }

        if (actionSelect.value !== 'delete') return;

        var checkedEntriesToDelete = getCheckedGalleryFileEntries();
        var indicesToDelete = checkedEntriesToDelete.map(function(entry) {
            return entry.index;
        });
        rememberPendingDeletedGalleryFileEntries(checkedEntriesToDelete);
        indicesToDelete.reverse().forEach(function(i) {
            currentFiles.splice(i, 1);
        });
        if (indicesToDelete.length > 0) opLog('刪除 Gallery File', { count: indicesToDelete.length });
        refreshAllFilePanels();
    });

    selectAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        listContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
    });

    deselectAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        listContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
    });

    fileListRestoreBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) return;
        restoreCurrentGalleryFilesFromSaved();
        refreshAllFilePanels();
        flashButtonSavedState(fileListRestoreBtn, '已恢復 ✓', 'Restore', 1000);
    });

    fileListAllSaveBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) return;
        writeCurrentGalleryFiles();
        opLog('保存檔案順序', { galleryId: currentGalleryId, count: currentFiles.length });
        flashButtonSavedState(fileListAllSaveBtn, '已保存 ✓', 'All Save', 1500);
    });

    saveFolderBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) return;
        writeCurrentGalleryFiles();
        opLog('保存資料夾管理結果', { galleryId: currentGalleryId, count: currentFiles.length });
        flashButtonSavedState(saveFolderBtn, '已保存 ✓', 'Save', 1500);
    });

    renamerSortAscBtn.addEventListener('click', function(e) {
        e.preventDefault();
        renamerCurrentSortDirection = 'asc';
        sortCurrentFilesForRenamer('asc');
        refreshAllFilePanels();
        applyRenamerSortButtonState();
    });

    renamerSortDescBtn.addEventListener('click', function(e) {
        e.preventDefault();
        renamerCurrentSortDirection = 'desc';
        sortCurrentFilesForRenamer('desc');
        refreshAllFilePanels();
        applyRenamerSortButtonState();
    });

    renamerSelectAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        renamerListContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
    });

    renamerDeselectAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        renamerListContainer.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
    });

    renamerRestoreBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) return;
        restoreCurrentGalleryFilesFromSaved();
        refreshAllFilePanels();
        flashButtonSavedState(renamerRestoreBtn, '已恢復 ✓', 'Restore', 1000);
    });

    renamerAllSaveBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) return;
        syncRenamerInputsToCurrentFiles();
        writeCurrentGalleryFiles();
        opLog('保存重新命名結果', { galleryId: currentGalleryId, count: currentFiles.length });
        refreshAllFilePanels();
        flashButtonSavedState(renamerAllSaveBtn, '已保存 ✓', 'All Save', 1500);
    });

    importExportExportBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!currentGalleryId) {
            flashButtonErrorState(importExportExportBtn, 'Fail', '導出', 1000);
            return;
        }

        var textarea = getImportExportTextareaSafe();
        if (!textarea) {
            warnLog('ImportExport', '找不到 Import/Export 輸入框');
            flashButtonErrorState(importExportExportBtn, 'Fail', '導出', 1000);
            return;
        }

        textarea.value = serializeCurrentGalleryImportExportPayload();
        flashButtonSavedState(importExportExportBtn, '已導出 ✓', '導出', 1000);
    });

    importExportImportBtn.addEventListener('click', function(e) {
        e.preventDefault();

        var importFailDelayMs = _getConfirmFeedbackSettingsSafe().delayMs;

        function flashImportExportImportFail() {
            flashColoredErrorState(importExportImportBtn, 'Fail', '導入', importFailDelayMs);
        }

        if (!currentGalleryId) {
            flashImportExportImportFail();
            return;
        }

        var textarea = getImportExportTextareaSafe();
        if (!textarea) {
            warnLog('ImportExport', '找不到 Import/Export 輸入框');
            flashImportExportImportFail();
            return;
        }

        var payload = null;
        try {
            payload = JSON.parse(textarea.value);
        } catch (err) {
            warnLog('ImportExport', 'JSON 解析失敗', err && err.message ? err.message : err);
            flashImportExportImportFail();
            return;
        }

        var validation = validateImportExportFilesPayload(payload);
        if (!validation.ok) {
            warnLog('ImportExport', validation.message);
            flashImportExportImportFail();
            return;
        }

        applyImportedFileOrder(validation.names);
        writeCurrentGalleryFiles();
        refreshAllFilePanels();
        opLog('ImportExport 導入成功', { galleryId: currentGalleryId, count: validation.names.length });
        flashButtonSavedState(importExportImportBtn, '已導入 ✓', '導入', 1000);
    });

    function refreshGallerySelect() {
        var prevId = currentGalleryId;
        while (gallerySelect.options.length > 0) gallerySelect.remove(0);
        var noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '--- 選擇圖庫 ---';
        gallerySelect.appendChild(noneOpt);

        var saved = getSavedGalleriesSafe();
        saved.forEach(function(g) {
            var opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = (g.title2 || g.title1 || '(無標題)');
            gallerySelect.appendChild(opt);
        });

        if (prevId) {
            gallerySelect.value = prevId;
            if (gallerySelect.value === prevId) {
                currentGalleryId = prevId;
                loadCurrentGalleryFilesSorted(prevId);
            } else {
                currentGalleryId = null;
                loadCurrentGalleryFilesSorted(null);
            }
        } else {
            currentGalleryId = null;
            loadCurrentGalleryFilesSorted(null);
        }

        renderFileList();
        if (currentSubPanel === 'foldermanager') renderFolderManager();
        if (currentSubPanel === 'filerename') renderRenamerList();
        renderImportExportPanel();
    }

    container.refreshPanel = function() { refreshGallerySelect(); };

    gallerySelect.addEventListener('change', function() {
        currentGalleryId = this.value;

        if (!currentGalleryId) {
            loadCurrentGalleryFilesSorted(null);
            renderFileList();
            renderFolderManager();
            renderRenamerList();
            renderImportExportPanel();
            return;
        }

        loadCurrentGalleryFilesSorted(currentGalleryId);
        renderFileList();
        if (currentSubPanel === 'foldermanager') renderFolderManager();
        if (currentSubPanel === 'filerename') renderRenamerList();
        renderImportExportPanel();
    });

    container.addEventListener('show', function() {
        if (firstOpen) {
            firstOpen = false;
            switchTab('filelist');
        }
        refreshGallerySelect();
    });

    return container;
}

function _isPlainObjectLoose(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildFifybujBackupSnapshot() {
    return {
        settings: Object.assign({}, getDefaultSettings(), loadSettings() || {}),
        commentTemplates: getCommentTemplatesSafe(),
        localDicts: getUserDictsRaw()
    };
}

function createFifybujBackupPacket(moduleKey, payload) {
    var packet = {
        "__fifybuj_backup__": true
    };
    if (moduleKey === 'settings') {
        packet.setting_payload = payload;
    } else if (moduleKey === 'commentTemplates') {
        packet.comment_templates_payload = payload;
    } else if (moduleKey === 'localDicts') {
        packet.local_dicts_payload = payload;
    }
    return packet;
}

function createFifybujBackupBundle() {
    var snapshot = buildFifybujBackupSnapshot();
    return {
        "__fifybuj_backup__": true,
        "app": "F-IFYBUJ",
        "scriptName": "F-IFYBUJ - Auto Create & Upload",
        "scriptVersion": "9.00",
        "schemaVersion": 1,
        "backupType": "bundle",
        "exportedAt": new Date().toISOString(),
        "payload": {
            "settings": snapshot.settings,
            "commentTemplates": snapshot.commentTemplates,
            "localDicts": snapshot.localDicts
        }
    };
}

function stringifyFifybujBackupData(data) {
    return JSON.stringify(data, null, 2);
}

function createFifybujModuleExportText(moduleKey) {
    var snapshot = buildFifybujBackupSnapshot();
    if (moduleKey === 'settings') {
        return stringifyFifybujBackupData(createFifybujBackupPacket('settings', snapshot.settings));
    }
    if (moduleKey === 'commentTemplates') {
        return stringifyFifybujBackupData(createFifybujBackupPacket('commentTemplates', snapshot.commentTemplates));
    }
    if (moduleKey === 'localDicts') {
        return stringifyFifybujBackupData(createFifybujBackupPacket('localDicts', snapshot.localDicts));
    }
    return '';
}

function createFifybujAllExportText() {
    return [
        createFifybujModuleExportText('settings'),
        createFifybujModuleExportText('commentTemplates'),
        createFifybujModuleExportText('localDicts')
    ].filter(function(item) {
        return !!item;
    }).join('\n\n');
}

function extractFifybujJsonObjectsFromText(text) {
    text = String(text || '');
    var results = [];
    var i = 0;

    while (i < text.length) {
        while (i < text.length && /\s/.test(text.charAt(i))) i++;
        if (i >= text.length) break;

        if (text.charAt(i) !== '{') {
            i++;
            continue;
        }

        var start = i;
        var depth = 0;
        var inString = false;
        var escaped = false;
        var completed = false;

        for (; i < text.length; i++) {
            var ch = text.charAt(i);

            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') {
                depth++;
                continue;
            }
            if (ch === '}') {
                depth--;
                if (depth === 0) {
                    var chunk = text.slice(start, i + 1);
                    try {
                        results.push(JSON.parse(chunk));
                    } catch (e) {}
                    i++;
                    completed = true;
                    break;
                }
            }
        }

        if (!completed) break;
    }

    return results;
}

function isFifybujBackupPacket(packet) {
    return !!(
        _isPlainObjectLoose(packet) &&
        packet.__fifybuj_backup__ === true
    );
}

function collectFifybujBackupPacketsFromText(text) {
    return extractFifybujJsonObjectsFromText(text).filter(isFifybujBackupPacket);
}

function getFifybujModulePayloadsFromText(text, moduleKey) {
    var packets = collectFifybujBackupPacketsFromText(text);
    var payloads = [];

    packets.forEach(function(packet) {
        if (moduleKey === 'settings') {
            if (Object.prototype.hasOwnProperty.call(packet, 'setting_payload')) {
                payloads.push(packet.setting_payload);
                return;
            }
            if (packet.backupType === 'module' && packet.module === 'settings') {
                payloads.push(packet.payload);
                return;
            }
            if (packet.backupType === 'bundle' && _isPlainObjectLoose(packet.payload) && Object.prototype.hasOwnProperty.call(packet.payload, 'settings')) {
                payloads.push(packet.payload.settings);
                return;
            }
        }

        if (moduleKey === 'commentTemplates') {
            if (Object.prototype.hasOwnProperty.call(packet, 'comment_templates_payload')) {
                payloads.push(packet.comment_templates_payload);
                return;
            }
            if (packet.backupType === 'module' && packet.module === 'commentTemplates') {
                payloads.push(packet.payload);
                return;
            }
            if (packet.backupType === 'bundle' && _isPlainObjectLoose(packet.payload) && Object.prototype.hasOwnProperty.call(packet.payload, 'commentTemplates')) {
                payloads.push(packet.payload.commentTemplates);
                return;
            }
        }

        if (moduleKey === 'localDicts') {
            if (Object.prototype.hasOwnProperty.call(packet, 'local_dicts_payload')) {
                payloads.push(packet.local_dicts_payload);
                return;
            }
            if (packet.backupType === 'module' && packet.module === 'localDicts') {
                payloads.push(packet.payload);
                return;
            }
            if (packet.backupType === 'bundle' && _isPlainObjectLoose(packet.payload) && Object.prototype.hasOwnProperty.call(packet.payload, 'localDicts')) {
                payloads.push(packet.payload.localDicts);
            }
        }
    });

    return payloads;
}

function getLatestFifybujModulePayloadFromText(text, moduleKey) {
    var payloads = getFifybujModulePayloadsFromText(text, moduleKey);
    return payloads.length ? payloads[payloads.length - 1] : null;
}

function importSettingsBackupPayload(payload) {
    if (!_isPlainObjectLoose(payload)) return false;
    saveSettings(Object.assign({}, getDefaultSettings(), payload || {}));
    return true;
}

function importCommentTemplatesBackupPayload(payload) {
    if (!Array.isArray(payload)) return false;
    saveCommentTemplatesSafe(payload);
    syncAllCommentTemplateDropdowns();
    return true;
}

function importLocalDictsBackupPayload(payload) {
    if (!_isPlainObjectLoose(payload)) return false;
    setUserDictsRaw(payload);
    refreshOpenDictManagerPanelIfOpen();
    return true;
}

function importFifybujModuleFromText(moduleKey, text) {
    var payload = getLatestFifybujModulePayloadFromText(text, moduleKey);
    if (payload == null) return false;

    if (moduleKey === 'settings') return importSettingsBackupPayload(payload);
    if (moduleKey === 'commentTemplates') return importCommentTemplatesBackupPayload(payload);
    if (moduleKey === 'localDicts') return importLocalDictsBackupPayload(payload);

    return false;
}

function importAllFifybujBackupFromText(text) {
    var packets = collectFifybujBackupPacketsFromText(text);
    var status = {
        settings: false,
        commentTemplates: false,
        localDicts: false
    };

    packets.forEach(function(packet) {
        if (Object.prototype.hasOwnProperty.call(packet, 'setting_payload')) {
            status.settings = importSettingsBackupPayload(packet.setting_payload) || status.settings;
        }
        if (Object.prototype.hasOwnProperty.call(packet, 'comment_templates_payload')) {
            status.commentTemplates = importCommentTemplatesBackupPayload(packet.comment_templates_payload) || status.commentTemplates;
        }
        if (Object.prototype.hasOwnProperty.call(packet, 'local_dicts_payload')) {
            status.localDicts = importLocalDictsBackupPayload(packet.local_dicts_payload) || status.localDicts;
        }

        if (packet.backupType === 'bundle' && _isPlainObjectLoose(packet.payload)) {
            if (Object.prototype.hasOwnProperty.call(packet.payload, 'settings')) {
                status.settings = importSettingsBackupPayload(packet.payload.settings) || status.settings;
            }
            if (Object.prototype.hasOwnProperty.call(packet.payload, 'commentTemplates')) {
                status.commentTemplates = importCommentTemplatesBackupPayload(packet.payload.commentTemplates) || status.commentTemplates;
            }
            if (Object.prototype.hasOwnProperty.call(packet.payload, 'localDicts')) {
                status.localDicts = importLocalDictsBackupPayload(packet.payload.localDicts) || status.localDicts;
            }
            return;
        }

        if (packet.backupType === 'module') {
            if (packet.module === 'settings') {
                status.settings = importSettingsBackupPayload(packet.payload) || status.settings;
            } else if (packet.module === 'commentTemplates') {
                status.commentTemplates = importCommentTemplatesBackupPayload(packet.payload) || status.commentTemplates;
            } else if (packet.module === 'localDicts') {
                status.localDicts = importLocalDictsBackupPayload(packet.payload) || status.localDicts;
            }
        }
    });

    return status;
}

// ==================== Setting 面板 ====================

function _getEnhancedSettingPanelColors(panel) {
    var fg = '#5C0D12';
    var bg = '#E0DED3';
    try {
        bg = getComputedStyle(panel).backgroundColor || bg;
    } catch (e) {}
    try {
        fg = getComputedStyle(panel.querySelector('div') || panel).color || fg;
    } catch (e2) {}
    if (!fg || fg === 'rgba(0, 0, 0, 0)' || fg === 'transparent') fg = '#5C0D12';
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#E0DED3';
    return { fg: fg, bg: bg };
}

function _styleEnhancedSettingOutlineButton(btn, colors, extraCss) {
    if (!btn) return btn;
    btn.style.cssText =
        'height: 26px;' +
        'padding: 0 12px;' +
        'box-sizing: border-box;' +
        'border: 1px solid ' + colors.fg + ';' +
        'border-radius: 2px;' +
        'cursor: pointer;' +
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'line-height: 24px;' +
        'box-shadow: none;' +
        'background: transparent;' +
        'color: ' + colors.fg + ';' +
        (extraCss || '');
    return btn;
}

function _flashEnhancedSettingJsonArea(textarea, ok) {
    if (!textarea) return;
    var oldBorderColor = textarea.style.borderColor;
    var oldColor = textarea.style.color;
    textarea.style.borderColor = ok ? '#007700' : '#CC0000';
    textarea.style.color = ok ? '#007700' : '#CC0000';
    setTimeout(function() {
        textarea.style.borderColor = oldBorderColor;
        textarea.style.color = oldColor;
    }, 1200);
}

function _showEnhancedImportConfirmDialog(message, onConfirm) {
    var overlay = document.createElement('div');
    overlay.style.cssText =
        'position: fixed;' +
        'inset: 0;' +
        'background: rgba(0,0,0,0.45);' +
        'z-index: 999999;' +
        'display: flex;' +
        'align-items: center;' +
        'justify-content: center;';

    var box = document.createElement('div');
    box.style.cssText =
        'width: 360px;' +
        'max-width: calc(100vw - 24px);' +
        'background: #E0DED3;' +
        'border: 1px solid #5C0D12;' +
        'border-radius: 2px;' +
        'padding: 12px;' +
        'box-sizing: border-box;';

    var title = document.createElement('div');
    title.textContent = '確認導入';
    title.style.cssText =
        'font-size: 10pt;' +
        'font-weight: bold;' +
        'color: #5C0D12;' +
        'margin-bottom: 8px;';

    var content = document.createElement('div');
    content.textContent = message || '確認要執行導入嗎？';
    content.style.cssText =
        'font-size: 9pt;' +
        'color: #5C0D12;' +
        'line-height: 1.5;' +
        'margin-bottom: 10px;';

    var hint = document.createElement('div');
    hint.textContent = '按 Enter 確認，按 Esc 取消';
    hint.style.cssText =
        'font-size: 8.5pt;' +
        'color: #5C0D12;' +
        'margin-bottom: 10px;';

    var btnRow = document.createElement('div');
    btnRow.style.cssText =
        'display: flex;' +
        'align-items: center;' +
        'justify-content: flex-end;' +
        'gap: 8px;';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText =
        'height: 26px;' +
        'padding: 0 12px;' +
        'box-sizing: border-box;' +
        'border: 1px solid #5C0D12;' +
        'border-radius: 2px;' +
        'cursor: pointer;' +
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'line-height: 24px;' +
        'background: transparent;' +
        'color: #5C0D12;';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = '確認';
    confirmBtn.style.cssText =
        'height: 26px;' +
        'padding: 0 12px;' +
        'box-sizing: border-box;' +
        'border: 1px solid #5C0D12;' +
        'border-radius: 2px;' +
        'cursor: pointer;' +
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'line-height: 24px;' +
        'background: transparent;' +
        'color: #5C0D12;';

    function closeDialog() {
        document.removeEventListener('keydown', onKeyDown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function confirmAction() {
        closeDialog();
        if (typeof onConfirm === 'function') onConfirm();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDialog();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
        }
    }

    cancelBtn.addEventListener('click', function(e) {
        e.preventDefault();
        closeDialog();
    });

    confirmBtn.addEventListener('click', function(e) {
        e.preventDefault();
        confirmAction();
    });

    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeDialog();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    box.appendChild(title);
    box.appendChild(content);
    box.appendChild(hint);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown, true);
    setTimeout(function() {
        confirmBtn.focus();
    }, 0);
}

function _parseEnhancedSettingInt(value, fallback) {
    var parsed = parseInt(value, 10);
    return isNaN(parsed) ? fallback : parsed;
}

function _enhancedEnsureColorPreviewForInput(input) {
    if (!input || input.__enhancedColorPreviewAttached) return;

    function rgbTextToHex(rgbText) {
        var normalized = _normalizeConfirmFeedbackColorCode(rgbText, '');
        if (!normalized) return '';
        var parts = normalized.split(',');
        var r = parseInt(parts[0], 10);
        var g = parseInt(parts[1], 10);
        var b = parseInt(parts[2], 10);

        function toHex(v) {
            var h = v.toString(16).toUpperCase();
            return h.length === 1 ? '0' + h : h;
        }

        return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    function hexToRgbText(hex) {
        var m = String(hex || '').trim().match(/^#([0-9a-fA-F]{6})$/);
        if (!m) return '';
        var n = m[1];
        var r = parseInt(n.slice(0, 2), 16);
        var g = parseInt(n.slice(2, 4), 16);
        var b = parseInt(n.slice(4, 6), 16);
        return r + ',' + g + ',' + b;
    }

    var picker = document.createElement('input');
    picker.type = 'color';
    picker.value = '#00FF00';
    picker.style.cssText =
        'width: 28px;' +
        'height: 24px;' +
        'margin-left: 6px;' +
        'padding: 0;' +
        'border: none;' +
        'outline: none;' +
        'box-shadow: none;' +
        'box-sizing: border-box;' +
        'vertical-align: middle;' +
        'background: transparent;' +
        'cursor: pointer;' +
        'flex-shrink: 0;';

    function updatePickerFromText() {
        var normalized = _normalizeConfirmFeedbackColorCode(input.value, '');
        if (normalized) {
            input.value = normalized;
            var hex = rgbTextToHex(normalized);
            if (hex) picker.value = hex;
            picker.style.opacity = '1';
        } else {
            picker.style.opacity = '0.45';
        }
    }

    function normalizeOnBlur() {
        var normalized = _normalizeConfirmFeedbackColorCode(input.value, '');
        if (normalized) input.value = normalized;
        updatePickerFromText();
    }

    function onPickerChange() {
        var rgbText = hexToRgbText(picker.value);
        if (rgbText) {
            input.value = rgbText;
            picker.style.opacity = '1';
        }
    }

    input.__updateColorPreview = updatePickerFromText;
    input.addEventListener('input', updatePickerFromText);
    input.addEventListener('change', updatePickerFromText);
    input.addEventListener('blur', normalizeOnBlur);

    picker.addEventListener('input', onPickerChange);
    picker.addEventListener('change', onPickerChange);

    if (input.parentNode) {
        if (input.nextSibling) input.parentNode.insertBefore(picker, input.nextSibling);
        else input.parentNode.appendChild(picker);
    }

    input.__enhancedColorPreviewAttached = true;
    updatePickerFromText();
}

function _collectEnhancedPriorityOrder(priorityTable) {
    var labelToKey = {
        'MTL': 'mtl',
        'Digital/DL版': 'digital',
        'Decensored/無修正': 'decensored',
        'Colorized/カラー化': 'colorized',
        'Textless/無字': 'textless',
        'Sample/見本': 'sample',
        'AI Generated/AI生成': 'aiGenerated',
        'Ongoing/進行中': 'ongoing',
        'Incomplete/ページ欠落': 'incomplete'
    };
    var out = {};
    Array.prototype.slice.call((priorityTable && priorityTable.children) || []).forEach(function(row, index) {
        var spans = row.querySelectorAll('span');
        if (spans.length < 2) return;
        var key = labelToKey[String(spans[1].textContent || '').trim()];
        if (key) out[key] = index + 1;
    });
    return out;
}

function _collectEnhancedSettingValues(panel) {
    var refs = panel && panel.__enhancedSettingRefs;
    if (!refs) return Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe());

    var defaults = getDefaultSettings();
    var current = getCurrentSettingsSafe();
    var priorities = Object.assign(
        {},
        defaults.optionPriorities || {},
        (current && current.optionPriorities) || {},
        _collectEnhancedPriorityOrder(refs.priorityTable)
    );

    var authorizedFolders = [];

    if (refs.authorizedFoldersManager && typeof refs.authorizedFoldersManager.getEntriesForSave === 'function') {
        var managerEntries = refs.authorizedFoldersManager.getEntriesForSave();
        authorizedFolders = normalizeAuthorizedFolderSettingsList(managerEntries.map(function(entry) {
            return {
                id: entry.id,
                label: entry.label
            };
        }));
    } else {
        authorizedFolders = normalizeAuthorizedFolderSettingsList((current && current.customAuthorizedFolders) || []);
    }

    var result = Object.assign({}, defaults, current, {
        customRootFolder: authorizedFolders.length === 1 ? authorizedFolders[0].label : '',
        customAuthorizedFolders: authorizedFolders,
        retryCount: refs.retryInput ? _parseEnhancedSettingInt(refs.retryInput.value, 3) : 3,
        translatedDefaultMTL: !!(refs.interfaceInputs[0] && refs.interfaceInputs[0].checked),
        nonJapaneseDefaultTranslated: !!(refs.interfaceInputs[1] && refs.interfaceInputs[1].checked),
        japaneseDefaultOfficialTextless: !!(refs.interfaceInputs[2] && refs.interfaceInputs[2].checked),
        japaneseDefaultAIGenerated: refs.aiGeneratedDefaultInput ? !!refs.aiGeneratedDefaultInput.checked : ((current && current.japaneseDefaultAIGenerated) !== false),
        deleteDoubleConfirm: !!(refs.interfaceInputs[3] && refs.interfaceInputs[3].checked),
        confirmBtnColorChange: !!(refs.interfaceInputs[4] && refs.interfaceInputs[4].checked),
        doubleConfirmMs: refs.interfaceInputs[5] ? _parseEnhancedSettingInt(refs.interfaceInputs[5].value, 1000) : 1000,
        confirmBtnColorMs: refs.interfaceInputs[6] ? _parseEnhancedSettingInt(refs.interfaceInputs[6].value, 1000) : 1000,
        confirmBtnSuccessColor: refs.interfaceInputs[7] ? _normalizeConfirmFeedbackColorCode(refs.interfaceInputs[7].value, '0,255,0') : '0,255,0',
        confirmBtnErrorColor: refs.interfaceInputs[8] ? _normalizeConfirmFeedbackColorCode(refs.interfaceInputs[8].value, '255,0,0') : '255,0,0',
        doubleConfirmColor: refs.interfaceInputs[9] ? _normalizeConfirmFeedbackColorCode(refs.interfaceInputs[9].value, '255,0,0') : '255,0,0',
        previewMaxWidth: refs.interfaceInputs[10] ? _parseEnhancedSettingInt(refs.interfaceInputs[10].value, 800) : 800,
        previewMaxHeight: refs.interfaceInputs[11] ? _parseEnhancedSettingInt(refs.interfaceInputs[11].value, 800) : 800,
        galleryFolderManagerCopyWithExtension: !!(refs.galleryFolderManagerInputs[0] && refs.galleryFolderManagerInputs[0].checked),
        autoSwitchDictDropdown: !!(refs.dictInputs[0] && refs.dictInputs[0].checked),
        dictPriorityPadLength: refs.dictInputs[1] ? _parseEnhancedSettingInt(refs.dictInputs[1].value, 5) : 5,
        showDebugLogsInBrowserConsole: !!(refs.debugInputs[0] && refs.debugInputs[0].checked),
        logToBrowserConsole: !!(refs.debugInputs[1] && refs.debugInputs[1].checked),
        optionPriorities: priorities
    });

    delete result.defaultAuthorizedFolderId;
    return result;
}

function _syncEnhancedSettingControlsFromStorage(panel) {
    var refs = panel && panel.__enhancedSettingRefs;
    if (!refs) return;
    var settings = migrateAuthorizedFolderSettings(Object.assign({}, getDefaultSettings(), loadSettings() || {}));

    if (refs.rootInput) refs.rootInput.value = settings.customRootFolder || '';
    if (refs.retryInput) refs.retryInput.value = settings.retryCount || 3;

    if (refs.interfaceInputs[0]) refs.interfaceInputs[0].checked = !!settings.translatedDefaultMTL;
    if (refs.interfaceInputs[1]) refs.interfaceInputs[1].checked = !!settings.nonJapaneseDefaultTranslated;
    if (refs.interfaceInputs[2]) refs.interfaceInputs[2].checked = !!settings.japaneseDefaultOfficialTextless;
    if (refs.aiGeneratedDefaultInput) refs.aiGeneratedDefaultInput.checked = settings.japaneseDefaultAIGenerated !== false;
    if (refs.interfaceInputs[3]) refs.interfaceInputs[3].checked = !!settings.deleteDoubleConfirm;
    if (refs.interfaceInputs[4]) refs.interfaceInputs[4].checked = settings.confirmBtnColorChange !== false;
    if (refs.interfaceInputs[5]) refs.interfaceInputs[5].value = settings.doubleConfirmMs || 1000;
    if (refs.interfaceInputs[6]) refs.interfaceInputs[6].value = settings.confirmBtnColorMs || 1000;
    if (refs.interfaceInputs[7]) refs.interfaceInputs[7].value = _normalizeConfirmFeedbackColorCode(settings.confirmBtnSuccessColor, '0,255,0');
    if (refs.interfaceInputs[8]) refs.interfaceInputs[8].value = _normalizeConfirmFeedbackColorCode(settings.confirmBtnErrorColor, '255,0,0');
    if (refs.interfaceInputs[9]) refs.interfaceInputs[9].value = _normalizeConfirmFeedbackColorCode(settings.doubleConfirmColor, '255,0,0');
    if (refs.interfaceInputs[10]) refs.interfaceInputs[10].value = settings.previewMaxWidth || 800;
    if (refs.interfaceInputs[11]) refs.interfaceInputs[11].value = settings.previewMaxHeight || 800;

    if (refs.galleryFolderManagerInputs[0]) refs.galleryFolderManagerInputs[0].checked = settings.galleryFolderManagerCopyWithExtension !== false;

    if (refs.dictInputs[0]) refs.dictInputs[0].checked = settings.autoSwitchDictDropdown !== false;
    if (refs.dictInputs[1]) refs.dictInputs[1].value = settings.dictPriorityPadLength || 5;

    if (refs.debugInputs[0]) refs.debugInputs[0].checked = !!settings.showDebugLogsInBrowserConsole;
    if (refs.debugInputs[1]) refs.debugInputs[1].checked = !!settings.logToBrowserConsole;

    if (refs.authorizedFoldersManager) {
        refs.authorizedFoldersManager.setLoading('讀取授權文件夾中...');
        getAuthorizedRootEntriesDetailed().then(function(entries) {
            if (!panel.__enhancedSettingRefs || !panel.__enhancedSettingRefs.authorizedFoldersManager) return;
            panel.__enhancedSettingRefs.authorizedFoldersManager.setEntries(entries);
        }).catch(function() {
            if (!panel.__enhancedSettingRefs || !panel.__enhancedSettingRefs.authorizedFoldersManager) return;
            panel.__enhancedSettingRefs.authorizedFoldersManager.setEntries((settings.customAuthorizedFolders || []).map(function(entry) {
                return {
                    id: entry.id,
                    label: entry.label,
                    handle: null,
                    status: 'missing',
                    statusText: '未授權'
                };
            }));
            panel.__enhancedSettingRefs.authorizedFoldersManager.setNote('讀取授權文件夾失敗', true);
        });
    }

    if (refs.interfaceInputs[7]) {
        _enhancedEnsureColorPreviewForInput(refs.interfaceInputs[7]);
        if (typeof refs.interfaceInputs[7].__updateColorPreview === 'function') refs.interfaceInputs[7].__updateColorPreview();
    }
    if (refs.interfaceInputs[8]) {
        _enhancedEnsureColorPreviewForInput(refs.interfaceInputs[8]);
        if (typeof refs.interfaceInputs[8].__updateColorPreview === 'function') refs.interfaceInputs[8].__updateColorPreview();
    }
    if (refs.interfaceInputs[9]) {
        _enhancedEnsureColorPreviewForInput(refs.interfaceInputs[9]);
        if (typeof refs.interfaceInputs[9].__updateColorPreview === 'function') refs.interfaceInputs[9].__updateColorPreview();
    }

    if (refs.priorityTable) {
        var keyToLabel = {
            mtl: 'MTL',
            digital: 'Digital/DL版',
            decensored: 'Decensored/無修正',
            colorized: 'Colorized/カラー化',
            textless: 'Textless/無字',
            sample: 'Sample/見本',
            aiGenerated: 'AI Generated/AI生成',
            ongoing: 'Ongoing/進行中',
            incomplete: 'Incomplete/ページ欠落'
        };
        var rowMap = {};
        Array.prototype.slice.call(refs.priorityTable.children || []).forEach(function(row) {
            var spans = row.querySelectorAll('span');
            if (spans.length < 2) return;
            rowMap[String(spans[1].textContent || '').trim()] = row;
        });

        Object.keys(keyToLabel).sort(function(a, b) {
            var pa = ((settings.optionPriorities || {})[a] || 99);
            var pb = ((settings.optionPriorities || {})[b] || 99);
            return pa - pb;
        }).forEach(function(key) {
            var row = rowMap[keyToLabel[key]];
            if (row) refs.priorityTable.appendChild(row);
        });

        Array.prototype.slice.call(refs.priorityTable.children || []).forEach(function(row, index) {
            var spans = row.querySelectorAll('span');
            if (spans.length > 0) spans[0].textContent = String(index + 1);
        });
    }
}

function _enhancedFindSettingControlRow(templateInput) {
    if (!templateInput) return null;
    if (templateInput.closest) {
        var labelRow = templateInput.closest('label');
        if (labelRow) return labelRow;
    }
    return templateInput.parentNode || null;
}

function _enhancedReplacePrimarySettingRowText(row, labelText) {
    if (!row) return false;
    var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null, false);
    var bestNode = null;
    var bestText = '';
    var current = null;

    while ((current = walker.nextNode())) {
        var text = String(current.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (!bestNode || text.length > bestText.length) {
            bestNode = current;
            bestText = text;
        }
    }

    if (!bestNode) return false;
    bestNode.nodeValue = bestNode.nodeValue.replace(bestText, labelText);
    return true;
}

function _enhancedInsertSettingControlLike(templateInput, options) {
    options = options || {};

    var templateRow = _enhancedFindSettingControlRow(templateInput);
    if (!templateRow || !templateRow.parentNode) return null;

    var anchorInput = options.insertAfterInput || templateInput;
    var anchorRow = _enhancedFindSettingControlRow(anchorInput) || templateRow;

    var clonedRow = templateRow.cloneNode(true);
    var clonedInputs = Array.prototype.slice.call(clonedRow.querySelectorAll('input') || []);
    if (!clonedInputs.length) return null;

    clonedInputs.forEach(function(input) {
        input.removeAttribute('id');
        input.removeAttribute('name');
        if (input.type === 'checkbox' || input.type === 'radio') {
            input.checked = false;
        } else {
            input.value = '';
        }
    });

    var clonedInput = clonedInputs[0];
    if (!clonedInput) return null;

    if (options.inputType) {
        clonedInput.type = options.inputType;
    }

    if (clonedInput.type === 'checkbox' || clonedInput.type === 'radio') {
        clonedInput.checked = !!options.checked;
    } else if (Object.prototype.hasOwnProperty.call(options, 'value')) {
        clonedInput.value = options.value == null ? '' : String(options.value);
    }

    if (Object.prototype.hasOwnProperty.call(options, 'labelText')) {
        _enhancedReplacePrimarySettingRowText(clonedRow, options.labelText);
    }

    if (anchorRow.nextSibling) {
        anchorRow.parentNode.insertBefore(clonedRow, anchorRow.nextSibling);
    } else {
        anchorRow.parentNode.appendChild(clonedRow);
    }

    return clonedInput;
}

function _enhancedSettingsGetJapaneseAIGeneratedDefaultEnabled() {
    var settings = Object.assign({}, getDefaultSettings(), loadSettings() || {});
    return settings.japaneseDefaultAIGenerated !== false;
}

function _enhancedNormalizeNodeText(node) {
    return String((node && node.textContent) || '').replace(/\s+/g, ' ').trim();
}

function _enhancedCheckboxText(input) {
    if (!input) return '';
    var parts = [];
    var label = input.closest ? input.closest('label') : null;
    if (label) parts.push(_enhancedNormalizeNodeText(label));
    if (input.parentNode) parts.push(_enhancedNormalizeNodeText(input.parentNode));
    if (input.nextElementSibling) parts.push(_enhancedNormalizeNodeText(input.nextElementSibling));
    if (input.parentNode && input.parentNode.nextElementSibling) parts.push(_enhancedNormalizeNodeText(input.parentNode.nextElementSibling));
    return parts.join(' | ');
}

function _enhancedFindAIGeneratedCheckbox(root) {
    var list = Array.prototype.slice.call((root || document).querySelectorAll('input[type="checkbox"]') || []);
    for (var i = 0; i < list.length; i++) {
        var text = _enhancedCheckboxText(list[i]);
        if (
            text.indexOf('AI Generated/AI生成') !== -1 ||
            text.indexOf('AI Generated') !== -1 ||
            text.indexOf('AI生成') !== -1
        ) {
            return list[i];
        }
    }
    return null;
}

function _enhancedContainerLooksJapanese(root) {
    if (!root) return false;

    var selects = Array.prototype.slice.call(root.querySelectorAll('select') || []);
    for (var i = 0; i < selects.length; i++) {
        var select = selects[i];
        var opt = select.options && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
        var text = String((opt && opt.textContent) || select.value || '').trim();
        if (/^japanese$/i.test(text) || text.indexOf('日本語') !== -1) return true;
    }

    var checkedInputs = Array.prototype.slice.call(root.querySelectorAll('input:checked') || []);
    for (var j = 0; j < checkedInputs.length; j++) {
        var input = checkedInputs[j];
        var mix = [
            String(input.value || ''),
            _enhancedCheckboxText(input)
        ].join(' | ');
        if (/^japanese$/i.test(String(input.value || '').trim()) || /(^|\W)Japanese(\W|$)/i.test(mix) || mix.indexOf('日本語') !== -1) {
            return true;
        }
    }

    return false;
}

function _enhancedSetChecked(input, checked) {
    if (!input || input.checked === checked) return;
    input.checked = checked;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e2) {}
}

function _enhancedTryApplyJapaneseAIGeneratedDefault(target) {
    if (!_enhancedSettingsGetJapaneseAIGeneratedDefaultEnabled()) return;
    var root = target && target.closest ? (
        target.closest('.s[data-custom="true"]') ||
        target.closest('form') ||
        target.closest('.s') ||
        target.closest('section') ||
        document
    ) : document;

    if (!root || !_enhancedContainerLooksJapanese(root)) return;

    var aiCheckbox = _enhancedFindAIGeneratedCheckbox(root);
    if (!aiCheckbox) return;

    _enhancedSetChecked(aiCheckbox, true);
}

if (!window.__fifybujJapaneseAIGeneratedDefaultInstalled) {
    window.__fifybujJapaneseAIGeneratedDefaultInstalled = true;

    document.addEventListener('change', function(e) {
        setTimeout(function() {
            _enhancedTryApplyJapaneseAIGeneratedDefault(e.target || document);
        }, 0);
    }, true);

    document.addEventListener('click', function(e) {
        setTimeout(function() {
            _enhancedTryApplyJapaneseAIGeneratedDefault(e.target || document);
        }, 0);
    }, true);
}

function _enhanceSettingPanelWithBackupUI(panel) {
    if (!panel || panel.__backupEnhanced) return panel;

    var colors = _getEnhancedSettingPanelColors(panel);
    var shell = panel.children[1];
    if (!shell || shell.children.length < 2) return panel;

    var sidebar = shell.children[0];
    var contentWrap = shell.children[1];
    var contentScroll = contentWrap && contentWrap.children ? contentWrap.children[0] : null;
    var contentFooter = contentWrap && contentWrap.children ? contentWrap.children[1] : null;
    if (!sidebar || !contentScroll) return panel;

    var originalPanels = Array.prototype.slice.call(contentScroll.children || []);
    if (originalPanels.length < 7) return panel;

    var generalPanel = originalPanels[0];
    var interfacePanel = originalPanels[1];
    var galleryFolderManagerPanel = originalPanels[2];
    var dictPanel = originalPanels[3];
    var priorityPanel = originalPanels[4];
    var debugPanel = originalPanels[5];
    var initPanel = originalPanels[6];

    var generalInputs = generalPanel.querySelectorAll('input');
    var interfaceInputs = interfacePanel.querySelectorAll('input');
    var galleryFolderManagerInputs = galleryFolderManagerPanel.querySelectorAll('input');
    var dictInputs = dictPanel.querySelectorAll('input');
    var debugInputs = debugPanel.querySelectorAll('input');
    var priorityTable = priorityPanel.lastElementChild;

    panel.__enhancedSettingRefs = {
        generalPanel: generalPanel,
        interfacePanel: interfacePanel,
        galleryFolderManagerPanel: galleryFolderManagerPanel,
        dictPanel: dictPanel,
        priorityPanel: priorityPanel,
        debugPanel: debugPanel,
        initPanel: initPanel,
        rootInput: generalInputs[0] || null,
        retryInput: generalInputs[1] || null,
        interfaceInputs: interfaceInputs,
        galleryFolderManagerInputs: galleryFolderManagerInputs,
        dictInputs: dictInputs,
        debugInputs: debugInputs,
        priorityTable: priorityTable,
        aiGeneratedDefaultInput: null
    };

    var officialTextlessInput = panel.__enhancedSettingRefs.interfaceInputs[2] || null;
    if (officialTextlessInput && !panel.__enhancedSettingRefs.aiGeneratedDefaultInput) {
        panel.__enhancedSettingRefs.aiGeneratedDefaultInput = _enhancedInsertSettingControlLike(
            officialTextlessInput,
            {
                insertAfterInput: officialTextlessInput,
                inputType: 'checkbox',
                labelText: '默認勾選AI生成',
                checked: true
            }
        );
    }

    if (contentFooter) {
        if (typeof contentFooter.__origDisplay === 'undefined') contentFooter.__origDisplay = contentFooter.style.display || '';
        if (typeof contentFooter.__origPadding === 'undefined') contentFooter.__origPadding = contentFooter.style.padding || '';
        if (typeof contentFooter.__origBorderTop === 'undefined') contentFooter.__origBorderTop = contentFooter.style.borderTop || '';
        if (typeof contentFooter.__origMinHeight === 'undefined') contentFooter.__origMinHeight = contentFooter.style.minHeight || '';
    }

    var rootRow = panel.__enhancedSettingRefs.rootInput ? _enhancedFindSettingControlRow(panel.__enhancedSettingRefs.rootInput) : null;
    var authorizedFolderManagerWrapper = document.createElement('div');
    authorizedFolderManagerWrapper.style.cssText = 'margin-bottom: 10px;';

    var authorizedFolderHeaderRow = document.createElement('div');
    authorizedFolderHeaderRow.style.cssText = 'display: flex;align-items: center;justify-content: space-between;gap: 8px;margin-bottom: 6px;flex-wrap: wrap;';

    var authorizedFolderTitle = document.createElement('div');
    authorizedFolderTitle.textContent = '自定義授權文件夾';
    authorizedFolderTitle.style.cssText = 'font-size: 9pt;font-weight: bold;color: ' + colors.fg + ';';

    var authorizedFolderActions = document.createElement('div');
    authorizedFolderActions.style.cssText = 'display: flex;align-items: center;gap: 6px;flex-wrap: wrap;';

    var addAuthorizedFolderBtn = document.createElement('button');
    addAuthorizedFolderBtn.type = 'button';
    addAuthorizedFolderBtn.textContent = '新增授權文件夾';
    _styleEnhancedSettingOutlineButton(addAuthorizedFolderBtn, colors);

    var refreshAuthorizedFolderStatusBtn = document.createElement('button');
    refreshAuthorizedFolderStatusBtn.type = 'button';
    refreshAuthorizedFolderStatusBtn.textContent = '重新整理狀態';
    _styleEnhancedSettingOutlineButton(refreshAuthorizedFolderStatusBtn, colors);

    authorizedFolderActions.appendChild(addAuthorizedFolderBtn);
    authorizedFolderActions.appendChild(refreshAuthorizedFolderStatusBtn);
    authorizedFolderHeaderRow.appendChild(authorizedFolderTitle);
    authorizedFolderHeaderRow.appendChild(authorizedFolderActions);

    var authorizedFolderListWrap = document.createElement('div');
    authorizedFolderListWrap.style.cssText = 'border: 1px solid ' + colors.fg + ';background: transparent;border-radius: 2px;overflow: hidden;';

    var authorizedFolderNote = document.createElement('div');
    authorizedFolderNote.style.cssText = 'font-size: 8.5pt;color: ' + colors.fg + ';margin-top: 6px;line-height: 1.5;';
    authorizedFolderNote.textContent = '只允許使用已授權文件夾中的文件夾與 ZIP。';

    authorizedFolderManagerWrapper.appendChild(authorizedFolderHeaderRow);
    authorizedFolderManagerWrapper.appendChild(authorizedFolderListWrap);
    authorizedFolderManagerWrapper.appendChild(authorizedFolderNote);

    if (rootRow && rootRow.parentNode) {
        rootRow.parentNode.replaceChild(authorizedFolderManagerWrapper, rootRow);
    } else {
        generalPanel.insertBefore(authorizedFolderManagerWrapper, generalPanel.firstChild ? generalPanel.firstChild.nextSibling : null);
    }

    function cloneAuthorizedFolderManagerEntries(entries) {
        return (Array.isArray(entries) ? entries : []).map(function(entry) {
            return {
                id: entry.id,
                label: entry.label,
                handle: entry.handle || null,
                status: entry.status || '',
                statusText: entry.statusText || ''
            };
        });
    }

    function getAuthorizedFolderManager() {
        return panel.__enhancedSettingRefs.authorizedFoldersManager;
    }

    function setAuthorizedFolderManagerNote(text, isError) {
        authorizedFolderNote.textContent = text || '';
        authorizedFolderNote.style.color = isError ? '#CC0000' : colors.fg;
    }

    function updateAuthorizedFolderEntryStatus(entry) {
        if (!entry || !entry.handle || !entry.handle.queryPermission) {
            entry.status = 'missing';
            entry.statusText = '未授權';
            return Promise.resolve(entry);
        }

        return Promise.resolve().then(function() {
            return entry.handle.queryPermission({ mode: 'read' });
        }).then(function(permission) {
            entry.status = permission === 'granted' ? 'granted' : 'prompt';
            entry.statusText = permission === 'granted' ? '✓ 已授權' : '未授權';
            return entry;
        }).catch(function() {
            entry.status = 'error';
            entry.statusText = '已失效';
            return entry;
        });
    }

    function renderAuthorizedFolderManager() {
        var manager = getAuthorizedFolderManager();
        if (!manager) return;

        while (authorizedFolderListWrap.firstChild) authorizedFolderListWrap.removeChild(authorizedFolderListWrap.firstChild);

        if (!manager.entries.length) {
            var emptyRow = document.createElement('div');
            emptyRow.textContent = '尚未新增授權文件夾';
            emptyRow.style.cssText = 'padding: 8px 10px;font-size: 9pt;color: ' + colors.fg + ';';
            authorizedFolderListWrap.appendChild(emptyRow);
            if (!authorizedFolderNote.textContent) setAuthorizedFolderManagerNote('請先新增至少一個授權文件夾。', false);
            return;
        }

        manager.entries.forEach(function(entry, index) {
            var row = document.createElement('div');
            row.style.cssText = 'display: flex;align-items: center;gap: 8px;padding: 6px 8px;border-bottom: ' + (index < manager.entries.length - 1 ? ('1px solid ' + colors.fg) : 'none') + ';flex-wrap: wrap;';

            var orderLabel = document.createElement('span');
            orderLabel.textContent = String(index + 1) + '.';
            orderLabel.style.cssText = 'width: 22px;min-width: 22px;text-align: right;font-size: 9pt;font-weight: bold;color: ' + colors.fg + ';';

            var labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.value = String(entry.label || '');
            applyTopBarControlStyle(labelInput, '220px', 'flex: 1 1 220px;min-width: 180px;background: transparent;color: ' + colors.fg + ';');
            labelInput.addEventListener('input', function() {
                entry.label = labelInput.value;
            });
            labelInput.addEventListener('change', function() {
                entry.label = String(labelInput.value || '').trim() || (entry.handle && entry.handle.name) || ('授權文件夾 ' + (index + 1));
                labelInput.value = entry.label;
                setAuthorizedFolderManagerNote('尚未保存授權文件夾變更', false);
            });

            var statusLabel = document.createElement('span');
            statusLabel.textContent = entry.statusText || (entry.handle ? '讀取中...' : '未授權');
            statusLabel.style.cssText = 'font-size: 8.5pt;color: ' + (entry.status === 'error' ? '#CC0000' : colors.fg) + ';white-space: nowrap;';

            var reauthorizeBtn = document.createElement('button');
            reauthorizeBtn.type = 'button';
            reauthorizeBtn.textContent = '重新授權';
            _styleEnhancedSettingOutlineButton(reauthorizeBtn, colors, 'height: 24px;padding: 0 8px;');
            reauthorizeBtn.addEventListener('click', function(e) {
                e.preventDefault();
                var pickerHost = null;

                try {
                    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.showDirectoryPicker === 'function') {
                        pickerHost = unsafeWindow;
                    }
                } catch (e) {}

                if (!pickerHost && typeof window.showDirectoryPicker === 'function') {
                    pickerHost = window;
                }

                if (!pickerHost) {
                    setAuthorizedFolderManagerNote('目前瀏覽器不支援授權文件夾選擇', true);
                    return;
                }

                Promise.resolve().then(function() {
                    return pickerHost.showDirectoryPicker.call(pickerHost, { mode: 'read' });
                }).then(function(handle) {
                    return Promise.resolve().then(function() {
                        if (!handle.requestPermission) return 'granted';
                        return handle.requestPermission({ mode: 'read' });
                    }).catch(function() {
                        return 'granted';
                    }).then(function(permission) {
                        if (permission && permission !== 'granted') {
                            setAuthorizedFolderManagerNote('重新授權失敗', true);
                            return;
                        }
                        entry.handle = handle;
                        entry.label = String(entry.label || '').trim() || handle.name || ('授權文件夾 ' + (index + 1));
                        return updateAuthorizedFolderEntryStatus(entry).then(function() {
                            renderAuthorizedFolderManager();
                            setAuthorizedFolderManagerNote('已更新授權文件夾，請按保存設置', false);
                        });
                    });
                }).catch(function(err) {
                    if (err && err.name === 'AbortError') return;
                    setAuthorizedFolderManagerNote('重新授權失敗', true);
                });
            });

            var deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.textContent = '刪除';
            _styleEnhancedSettingOutlineButton(deleteBtn, colors, 'height: 24px;padding: 0 8px;');
            deleteBtn.addEventListener('click', function(e) {
                e.preventDefault();
                manager.entries = manager.entries.filter(function(item) {
                    return item.id !== entry.id;
                });
                renderAuthorizedFolderManager();
                setAuthorizedFolderManagerNote('已移除授權文件夾，請按保存設置', false);
            });

            row.appendChild(orderLabel);
            row.appendChild(labelInput);
            row.appendChild(statusLabel);
            row.appendChild(reauthorizeBtn);
            row.appendChild(deleteBtn);
            authorizedFolderListWrap.appendChild(row);
        });
    }

    function refreshAuthorizedFolderManagerStatuses() {
        var manager = getAuthorizedFolderManager();
        if (!manager) return Promise.resolve([]);
        setAuthorizedFolderManagerNote('授權狀態檢查中...', false);

        return Promise.all(manager.entries.map(function(entry) {
            return updateAuthorizedFolderEntryStatus(entry);
        })).then(function(results) {
            manager.entries = cloneAuthorizedFolderManagerEntries(results);
            renderAuthorizedFolderManager();
            setAuthorizedFolderManagerNote(results.length ? '已更新授權狀態' : '尚未新增授權文件夾', false);
            return results;
        }).catch(function(err) {
            renderAuthorizedFolderManager();
            setAuthorizedFolderManagerNote('授權狀態檢查失敗', true);
            throw err;
        });
    }

    var authorizedFolderManager = {
        entries: [],
        render: renderAuthorizedFolderManager,
        refresh: refreshAuthorizedFolderManagerStatuses,
        setNote: setAuthorizedFolderManagerNote,
        setLoading: function(text) {
            while (authorizedFolderListWrap.firstChild) authorizedFolderListWrap.removeChild(authorizedFolderListWrap.firstChild);
            var loadingRow = document.createElement('div');
            loadingRow.textContent = text || '讀取中...';
            loadingRow.style.cssText = 'padding: 8px 10px;font-size: 9pt;color: ' + colors.fg + ';';
            authorizedFolderListWrap.appendChild(loadingRow);
            setAuthorizedFolderManagerNote(text || '讀取中...', false);
        },
        setEntries: function(entries) {
            this.entries = cloneAuthorizedFolderManagerEntries(entries);
            renderAuthorizedFolderManager();
            setAuthorizedFolderManagerNote(this.entries.length ? '只允許從已授權文件夾內選擇 ZIP 與文件夾。' : '請先新增至少一個授權文件夾。', false);
        },
        getEntriesForSave: function() {
            var source = cloneAuthorizedFolderManagerEntries(this.entries);
            return source.map(function(entry, index) {
                return {
                    id: entry.id,
                    label: String(entry.label || '').trim() || (entry.handle && entry.handle.name) || ('授權文件夾 ' + (index + 1)),
                    handle: entry.handle || null,
                    status: entry.status || '',
                    statusText: entry.statusText || ''
                };
            });
        }
    };

    panel.__enhancedSettingRefs.authorizedFoldersManager = authorizedFolderManager;
    authorizedFolderManager.render();

    addAuthorizedFolderBtn.addEventListener('click', function(e) {
        e.preventDefault();

        var pickerHost = null;

        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.showDirectoryPicker === 'function') {
                pickerHost = unsafeWindow;
            }
        } catch (e) {}

        if (!pickerHost && typeof window.showDirectoryPicker === 'function') {
            pickerHost = window;
        }

        if (!pickerHost) {
            setAuthorizedFolderManagerNote('目前瀏覽器不支援授權文件夾選擇', true);
            return;
        }

        Promise.resolve().then(function() {
            return pickerHost.showDirectoryPicker.call(pickerHost, { mode: 'read' });
        }).then(function(handle) {
            return Promise.resolve().then(function() {
                if (!handle.requestPermission) return 'granted';
                return handle.requestPermission({ mode: 'read' });
            }).catch(function() {
                return 'granted';
            }).then(function(permission) {
                if (permission && permission !== 'granted') {
                    setAuthorizedFolderManagerNote('授權文件夾未授權成功', true);
                    return;
                }

                return Promise.all(authorizedFolderManager.entries.map(function(entry) {
                    if (!entry.handle || !entry.handle.isSameEntry) return Promise.resolve(false);
                    return Promise.resolve(entry.handle.isSameEntry(handle)).catch(function() {
                        return false;
                    });
                })).then(function(matches) {
                    var existingIndex = matches.indexOf(true);

                    if (existingIndex >= 0) {
                        authorizedFolderManager.entries[existingIndex].handle = handle;
                        authorizedFolderManager.entries[existingIndex].label = String(authorizedFolderManager.entries[existingIndex].label || '').trim() || handle.name || ('授權文件夾 ' + (existingIndex + 1));
                    } else {
                        authorizedFolderManager.entries.push({
                            id: _generateAuthorizedFolderId(),
                            label: handle.name || ('授權文件夾 ' + (authorizedFolderManager.entries.length + 1)),
                            handle: handle,
                            status: 'granted',
                            statusText: '✓ 已授權'
                        });
                    }

                    return refreshAuthorizedFolderManagerStatuses().catch(function() {
                        renderAuthorizedFolderManager();
                    }).then(function() {
                        setAuthorizedFolderManagerNote('已新增授權文件夾，請按保存設置', false);
                    });
                });
            });
        }).catch(function(err) {
            if (err && err.name === 'AbortError') return;
            setAuthorizedFolderManagerNote('新增授權文件夾失敗', true);
        });
    });

    refreshAuthorizedFolderStatusBtn.addEventListener('click', function(e) {
        e.preventDefault();
        refreshAuthorizedFolderManagerStatuses().catch(function() {
            return null;
        });
    });

    function persistSilently() {
        saveSettings(_collectEnhancedSettingValues(panel));
    }

    var autosaveInputs = [
        panel.__enhancedSettingRefs.retryInput,
        interfaceInputs[0], interfaceInputs[1], interfaceInputs[2], panel.__enhancedSettingRefs.aiGeneratedDefaultInput, interfaceInputs[3], interfaceInputs[4],
        interfaceInputs[5], interfaceInputs[6], interfaceInputs[7], interfaceInputs[8], interfaceInputs[9], interfaceInputs[10], interfaceInputs[11],
        panel.__enhancedSettingRefs.galleryFolderManagerInputs[0],
        dictInputs[0], dictInputs[1],
        debugInputs[0], debugInputs[1]
    ];

    autosaveInputs.forEach(function(input) {
        if (!input) return;
        input.addEventListener('change', persistSilently);
    });

    if (priorityTable) {
        priorityTable.addEventListener('click', function(e) {
            if (!e.target || e.target.tagName !== 'BUTTON') return;
            setTimeout(persistSilently, 0);
        });
    }

    var footerSaveBtn = contentFooter ? contentFooter.querySelector('button') : null;
    if (footerSaveBtn && footerSaveBtn.parentNode) {
        var replacedFooterSaveBtn = footerSaveBtn.cloneNode(true);
        footerSaveBtn.parentNode.replaceChild(replacedFooterSaveBtn, footerSaveBtn);
        footerSaveBtn = replacedFooterSaveBtn;

        footerSaveBtn.addEventListener('click', function(e) {
            e.preventDefault();

            var collectedSettings = _collectEnhancedSettingValues(panel);

            persistAuthorizedRootEntries(authorizedFolderManager.getEntriesForSave(), collectedSettings).then(function() {
                _syncEnhancedSettingControlsFromStorage(panel);
                setAuthorizedFolderManagerNote('已保存授權文件夾設定', false);
                flashButtonSavedState(footerSaveBtn, '已保存 ✓', '保存設置', 1500);
            }).catch(function(err) {
                errorLog('Settings', '保存授權文件夾失敗', err && (err.message || err));
                setAuthorizedFolderManagerNote('保存授權文件夾失敗', true);
                flashButtonErrorState(footerSaveBtn, 'Fail', '保存設置', 1000);
            });
        });
    }

    var backupPanel = document.createElement('div');
    backupPanel.style.cssText = 'display: none;';

    var backupTitle = document.createElement('div');
    backupTitle.textContent = '備份與還原';
    backupTitle.style.cssText =
        'font-size: 10pt;' +
        'font-weight: bold;' +
        'color: ' + colors.fg + ';' +
        'padding-bottom: 6px;' +
        'margin-bottom: 10px;' +
        'border-bottom: 1px solid ' + colors.fg + ';';
    backupPanel.appendChild(backupTitle);

    var backupRowsWrap = document.createElement('div');
    backupRowsWrap.style.cssText =
        'display: flex;' +
        'flex-direction: column;' +
        'gap: 8px;' +
        'margin-bottom: 12px;';

    var jsonHeaderRow = document.createElement('div');
    jsonHeaderRow.style.cssText =
        'display: flex;' +
        'align-items: center;' +
        'justify-content: flex-start;' +
        'gap: 8px;' +
        'flex-wrap: wrap;' +
        'margin: 6px 0;';

    var jsonTitle = document.createElement('div');
    jsonTitle.textContent = 'JSON導出/導入區';
    jsonTitle.style.cssText =
        'display: inline-block;' +
        'width: 180px;' +
        'min-width: 180px;' +
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'color: ' + colors.fg + ';' +
        'white-space: nowrap;';

    var jsonActionRow = document.createElement('div');
    jsonActionRow.style.cssText =
        'display: flex;' +
        'align-items: center;' +
        'justify-content: flex-start;' +
        'gap: 8px;' +
        'flex-wrap: wrap;';

    jsonHeaderRow.appendChild(jsonTitle);
    jsonHeaderRow.appendChild(jsonActionRow);
    backupPanel.appendChild(backupRowsWrap);
    backupPanel.appendChild(jsonHeaderRow);

    var jsonArea = document.createElement('textarea');
    jsonArea.rows = 10;
    jsonArea.style.cssText =
        'width: 100%;' +
        'height: 180px;' +
        'min-height: 180px;' +
        'max-height: 180px;' +
        'box-sizing: border-box;' +
        'border: 1px solid ' + colors.fg + ';' +
        'background: transparent;' +
        'color: ' + colors.fg + ';' +
        'font-size: 9pt;' +
        'padding: 6px;' +
        'border-radius: 2px;' +
        'outline: none;' +
        'resize: none;' +
        'overflow-x: auto;' +
        'overflow-y: auto;' +
        'line-height: 1.4;' +
        'white-space: pre;' +
        'word-break: normal;';
    function adjustJsonAreaHeight() {
        jsonArea.style.height = '180px';
        jsonArea.style.minHeight = '180px';
        jsonArea.style.maxHeight = '180px';
        jsonArea.style.overflowX = 'auto';
        jsonArea.style.overflowY = 'auto';
    }
    jsonArea.addEventListener('input', adjustJsonAreaHeight);
    backupPanel.appendChild(jsonArea);

    panel.__enhancedSettingRefs.jsonArea = jsonArea;
    adjustJsonAreaHeight();

    function handleModuleExport(moduleKey) {
        jsonArea.value = createFifybujModuleExportText(moduleKey);
        adjustJsonAreaHeight();
        _flashEnhancedSettingJsonArea(jsonArea, !!jsonArea.value);
    }

    function handleModuleImport(moduleKey) {
        _showEnhancedImportConfirmDialog('確認要導入目前輸入框中的對應模塊資料嗎？', function() {
            var ok = importFifybujModuleFromText(moduleKey, jsonArea.value);
            if (ok && moduleKey === 'settings') _syncEnhancedSettingControlsFromStorage(panel);
            adjustJsonAreaHeight();
            _flashEnhancedSettingJsonArea(jsonArea, ok);
        });
    }

    function createBackupActionRow(labelText, moduleKey) {
        var row = document.createElement('div');
        row.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'gap: 8px;' +
            'flex-wrap: wrap;';

        var label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText =
            'display: inline-block;' +
            'width: 180px;' +
            'min-width: 180px;' +
            'font-size: 9pt;' +
            'color: ' + colors.fg + ';' +
            'white-space: nowrap;';
        row.appendChild(label);

        var exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.textContent = '導出';
        _styleEnhancedSettingOutlineButton(exportBtn, colors);

        var importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.textContent = '導入';
        _styleEnhancedSettingOutlineButton(importBtn, colors);

        exportBtn.addEventListener('click', function(e) {
            e.preventDefault();
            handleModuleExport(moduleKey);
        });

        importBtn.addEventListener('click', function(e) {
            e.preventDefault();
            handleModuleImport(moduleKey);
        });

        row.appendChild(exportBtn);
        row.appendChild(importBtn);
        return row;
    }

    backupRowsWrap.appendChild(createBackupActionRow('Setting', 'settings'));
    backupRowsWrap.appendChild(createBackupActionRow('Comment Template', 'commentTemplates'));
    backupRowsWrap.appendChild(createBackupActionRow('Dict Manager', 'localDicts'));

    var exportAllBtn = document.createElement('button');
    exportAllBtn.type = 'button';
    exportAllBtn.textContent = '導出全部';
    _styleEnhancedSettingOutlineButton(exportAllBtn, colors);

    var importAllBtn = document.createElement('button');
    importAllBtn.type = 'button';
    importAllBtn.textContent = '導入全部';
    _styleEnhancedSettingOutlineButton(importAllBtn, colors);

    var clearJsonBtn = document.createElement('button');
    clearJsonBtn.type = 'button';
    clearJsonBtn.textContent = '清空';
    _styleEnhancedSettingOutlineButton(clearJsonBtn, colors);

    exportAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        jsonArea.value = createFifybujAllExportText();
        adjustJsonAreaHeight();
        _flashEnhancedSettingJsonArea(jsonArea, !!jsonArea.value);
    });

    importAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        _showEnhancedImportConfirmDialog('確認要導入目前輸入框中的所有可識別模塊資料嗎？', function() {
            var status = importAllFifybujBackupFromText(jsonArea.value);
            var ok = !!(status.settings || status.commentTemplates || status.localDicts);
            if (status.settings) _syncEnhancedSettingControlsFromStorage(panel);
            adjustJsonAreaHeight();
            _flashEnhancedSettingJsonArea(jsonArea, ok);
        });
    });

    clearJsonBtn.addEventListener('click', function(e) {
        e.preventDefault();
        jsonArea.value = '';
        adjustJsonAreaHeight();
        _flashEnhancedSettingJsonArea(jsonArea, true);
    });

    jsonActionRow.appendChild(exportAllBtn);
    jsonActionRow.appendChild(importAllBtn);
    jsonActionRow.appendChild(clearJsonBtn);

    contentScroll.appendChild(backupPanel);

    var buttonTemplate = sidebar.querySelector('button');
    var buttonTexts = Array.prototype.slice.call(sidebar.querySelectorAll('button')).map(function(btn) {
        return btn.textContent;
    });
    buttonTexts.push('備份與還原');
    sidebar.innerHTML = '';

    var allPanels = originalPanels.concat([backupPanel]);
    var allButtons = [];

    function setActiveTab(index) {
        allPanels.forEach(function(tabPanel, tabIndex) {
            tabPanel.style.display = tabIndex === index ? 'block' : 'none';
        });
        allButtons.forEach(function(btn, btnIndex) {
            btn.style.background = btnIndex === index ? colors.fg : 'transparent';
            btn.style.color = btnIndex === index ? colors.bg : colors.fg;
            btn.style.borderColor = colors.fg;
        });
        if (contentFooter) {
            var hasFooterButtons = !!contentFooter.querySelector('button');
            var shouldHideFooter = !hasFooterButtons || index === 6 || index === 7;
            contentFooter.style.display = shouldHideFooter ? 'none' : (contentFooter.__origDisplay || '');
            contentFooter.style.padding = contentFooter.__origPadding || '';
            contentFooter.style.borderTop = contentFooter.__origBorderTop || '';
            contentFooter.style.minHeight = contentFooter.__origMinHeight || '';
        }
    }

    buttonTexts.forEach(function(text, index) {
        var btn = buttonTemplate ? buttonTemplate.cloneNode(true) : document.createElement('button');
        btn.textContent = text;
        btn.type = 'button';
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            setActiveTab(index);
        });
        sidebar.appendChild(btn);
        allButtons.push(btn);
    });

    panel.__backupEnhanced = true;
    _syncEnhancedSettingControlsFromStorage(panel);
    setActiveTab(0);
    return panel;
}

function _fifybujCleanupUnexpectedRomanizationOptions(root) {
    Array.prototype.slice.call((root || document).querySelectorAll('select') || []).forEach(function(select) {
        var keepRomanization = !!(select.__fifybujAllActionSelect || select.getAttribute('data-fifybuj-all-action-select') === '1');
        Array.prototype.slice.call(select.options || []).forEach(function(opt) {
            var isRomanization = String(opt.value || '') === '__fifybuj_bulk_romanization__' || String(opt.textContent || '').trim() === 'Romanization';
            if (!isRomanization || keepRomanization) return;
            select.removeChild(opt);
        });
    });
}

function _fifybujBulkActionLooksLikeAllActionSelect(select) {
    return !!(select && (select.__fifybujAllActionSelect || select.getAttribute('data-fifybuj-all-action-select') === '1'));
}

function _fifybujGetSelectedOptionText(select) {
    if (!select) return '';
    var opt = select.options && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    return String((opt && opt.textContent) || select.value || '').trim();
}

function _fifybujEnsureRomanizationOptionInSelect(select) {
    _fifybujCleanupUnexpectedRomanizationOptions(select && select.ownerDocument ? select.ownerDocument : document);
}

function _fifybujEnsureRomanizationOptionInDocument(root) {
    _fifybujCleanupUnexpectedRomanizationOptions(root || document);
}

function _fifybujFindNearestBulkActionSelect(btn) {
    var node = btn;
    var depth = 0;
    while (node && node !== document.body && depth < 6) {
        var selects = node.querySelectorAll ? Array.prototype.slice.call(node.querySelectorAll('select') || []) : [];
        var matched = selects.find(function(select) {
            return _fifybujBulkActionLooksLikeAllActionSelect(select);
        });
        if (matched) return matched;
        node = node.parentElement;
        depth++;
    }
    return null;
}

function _fifybujFindRomanizationTrigger(root) {
    if (!root || !root.querySelectorAll) return null;
    var nodes = Array.prototype.slice.call(root.querySelectorAll('button, a, input[type="button"], input[type="submit"]') || []);
    for (var i = 0; i < nodes.length; i++) {
        var text = String(nodes[i].value || nodes[i].textContent || '').trim();
        if (/Romanization/i.test(text) || text.indexOf('羅馬音') !== -1) return nodes[i];
    }
    return null;
}

function _fifybujTryKnownBulkRomanizationHooks() {
    var names = [
        'bulkRomanizeSelectedTitles',
        'bulkRomanizeSelectedTitlesSafe',
        'bulkRomanizeSelectedTitlesRewritten',
        'applyRomanizationToSelectedTitles',
        'applyRomanizationToCheckedTitles',
        'romanizeSelectedTitles',
        'romanizeCheckedGalleryTitles',
        'runRomanizationForSelectedGalleries',
        'runRomanizationForCheckedGalleries'
    ];

    for (var i = 0; i < names.length; i++) {
        var fn = window[names[i]];
        if (typeof fn === 'function') {
            try {
                fn();
                return true;
            } catch (e) {}
        }
    }
    return false;
}

function _fifybujFallbackBulkRomanization() {
    var count = 0;
    var checkedBoxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]:checked') || []).filter(function(input) {
        if (input.closest('.dict-manager-container')) return false;
        if (input.closest('.show-file-list-container')) return false;
        if (input.closest('.setting-panel')) return false;
        if (input.closest('.dict-manager-panel')) return false;
        return true;
    });

    checkedBoxes.forEach(function(input) {
        var root = (input.closest && input.closest('tr, li, .row, .card, .item, .gallery, .thumb, .s')) || input.parentElement;
        var trigger = _fifybujFindRomanizationTrigger(root);
        if (!trigger) return;
        try {
            trigger.click();
            count++;
        } catch (e) {}
    });

    return count;
}

if (!window.__fifybujBulkRomanizationEnhancerInstalled) {
    window.__fifybujBulkRomanizationEnhancerInstalled = true;

    document.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('button, a, input[type="button"], input[type="submit"]') : null;
        if (!btn) return;

        if (btn.closest && btn.closest('.show-file-list-container')) return;

        var btnText = String(btn.value || btn.textContent || '').trim();
        if (btnText !== 'Save') return;

        var select = _fifybujFindNearestBulkActionSelect(btn);
        if (!select) return;

        var selectedText = _fifybujGetSelectedOptionText(select);
        if (selectedText !== 'Romanization' && select.value !== '__fifybuj_bulk_romanization__') return;

        e.preventDefault();
        e.stopImmediatePropagation();

        if (_fifybujTryKnownBulkRomanizationHooks()) return;
        _fifybujFallbackBulkRomanization();
    }, true);

    var observer = new MutationObserver(function() {
        _fifybujEnsureRomanizationOptionInDocument(document);
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

    setTimeout(function() {
        _fifybujEnsureRomanizationOptionInDocument(document);
    }, 0);
}

function _getFifybujDeleteConfirmSettings() {
    var settings = Object.assign({}, getDefaultSettings(), loadSettings() || {});
    return {
        deleteDoubleConfirm: !!settings.deleteDoubleConfirm,
        confirmBtnColorChange: settings.confirmBtnColorChange !== false,
        doubleConfirmMs: _parseEnhancedSettingInt(settings.doubleConfirmMs, 1000)
    };
}

function _getFifybujButtonText(btn) {
    return String((btn && (btn.value || btn.textContent)) || '').replace(/\s+/g, ' ').trim();
}

function _restoreFifybujDeleteConfirmButtonState(btn) {
    if (!btn) return;
    if (btn.__fifybujDeleteConfirmTimer) {
        clearTimeout(btn.__fifybujDeleteConfirmTimer);
        btn.__fifybujDeleteConfirmTimer = null;
    }
    btn.__fifybujDeleteConfirmArmed = false;
    btn.__fifybujDeleteConfirmExpireAt = 0;

    if (btn.__fifybujDeleteConfirmFeedbackController && typeof btn.__fifybujDeleteConfirmFeedbackController.restore === 'function') {
        btn.__fifybujDeleteConfirmFeedbackController.restore();
        btn.__fifybujDeleteConfirmFeedbackController = null;
    }
}

function _armFifybujDeleteConfirmButtonState(btn, settings) {
    if (!btn) return;

    _restoreFifybujDeleteConfirmButtonState(btn);

    btn.__fifybujDeleteConfirmArmed = true;
    btn.__fifybujDeleteConfirmExpireAt = Date.now() + Math.max(200, settings.doubleConfirmMs || 1000);
    btn.__fifybujDeleteConfirmFeedbackController = _beginFeedbackState(btn, {
        restoreText: _getFifybujButtonText(btn),
        useColor: true,
        colorType: 'error'
    });

    btn.__fifybujDeleteConfirmTimer = setTimeout(function() {
        _restoreFifybujDeleteConfirmButtonState(btn);
    }, Math.max(200, settings.doubleConfirmMs || 1000));
}

function _fifybujNodeMentionsCommentTemplate(node) {
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
        var text = String(node.textContent || '');
        if (text.indexOf('Comment Template') !== -1) return true;
        if (text.indexOf('Dict Manager') !== -1) return false;
        node = node.parentElement;
        depth++;
    }
    return false;
}

function _looksLikeCommentTemplateDeleteButton(btn) {
    if (!btn) return false;
    var text = _getFifybujButtonText(btn);
    if (!(text === '刪除' || /^delete$/i.test(text) || text === '確認刪除')) return false;
    return _fifybujNodeMentionsCommentTemplate(btn);
}

function _handleFifybujCommentTemplateDeleteClick(btn, event) {
    if (!btn) return;
    var settings = _getFifybujDeleteConfirmSettings();

    if (!settings.deleteDoubleConfirm) {
        _restoreFifybujDeleteConfirmButtonState(btn);
        return;
    }

    var stillArmed = !!btn.__fifybujDeleteConfirmArmed && Date.now() <= (btn.__fifybujDeleteConfirmExpireAt || 0);

    if (stillArmed) {
        _restoreFifybujDeleteConfirmButtonState(btn);
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    _armFifybujDeleteConfirmButtonState(btn, settings);
}

if (!window.__fifybujCommentTemplateDeleteConfirmInstalled) {
    window.__fifybujCommentTemplateDeleteConfirmInstalled = true;

    document.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('button, a, input[type="button"], input[type="submit"]') : null;
        if (!_looksLikeCommentTemplateDeleteButton(btn)) return;
        _handleFifybujCommentTemplateDeleteClick(btn, e);
    }, true);
}

function createSettingPanel(sectionDiv) {
    var panel = __createSettingPanelSidebar_card_v6(sectionDiv);
    return _enhanceSettingPanelWithBackupUI(panel);
}

function __createSettingPanelSidebar_card_v6(sectionDiv) {
    var __pageBg = '';
    try {
        __pageBg = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor || '';
    } catch (e) {}
    if (!__pageBg || __pageBg === 'rgba(0, 0, 0, 0)' || __pageBg === 'transparent') __pageBg = '#E0DED3';

    var __sampleColorEl = document.querySelector('.s .h .l') || document.body;
    var __pageFg = '';
    try {
        __pageFg = getComputedStyle(__sampleColorEl).color || '';
    } catch (e2) {}
    if (!__pageFg || __pageFg === 'rgba(0, 0, 0, 0)' || __pageFg === 'transparent') __pageFg = '#5C0D12';

    var __activeBg = __pageFg;
    var __activeFg = __pageBg;
    var __settings = loadSettings();

    function __styleInput(el, width) {
        if (!el) return el;
        el.style.cssText =
            'width: ' + (width || '220px') + ';' +
            'height: 24px;' +
            'box-sizing: border-box;' +
            'border: 1px solid ' + __pageFg + ';' +
            'background: transparent;' +
            'color: ' + __pageFg + ';' +
            'font-size: 9pt;' +
            'padding: 0 6px;' +
            'border-radius: 2px;' +
            'outline: none;' +
            'box-shadow: none;';
        return el;
    }

    function __styleButton(btn, primary) {
        if (!btn) return btn;
        btn.style.cssText =
            'height: 26px;' +
            'padding: 0 12px;' +
            'box-sizing: border-box;' +
            'border: 1px solid ' + __pageFg + ';' +
            'border-radius: 2px;' +
            'cursor: pointer;' +
            'font-size: 9pt;' +
            'font-weight: bold;' +
            'line-height: 24px;' +
            'box-shadow: none;' +
            'background: ' + (primary ? __pageFg : 'transparent') + ';' +
            'color: ' + (primary ? __pageBg : __pageFg) + ';';
        return btn;
    }

    function __styleCheckbox(cb) {
        if (!cb) return cb;
        cb.style.cssText =
            'margin: 0;' +
            'width: 14px;' +
            'height: 14px;' +
            'accent-color: ' + __pageFg + ';' +
            'flex: 0 0 auto;';
        return cb;
    }

    function __bindNumberRange(input, min, max) {
        if (!input) return;
        input.addEventListener('input', function() {
            var raw = String(input.value || '').trim();
            if (raw === '') return;
            var v = parseInt(raw, 10);
            if (isNaN(v)) {
                input.value = '';
                return;
            }
            if (min !== null && min !== undefined && v < min) v = min;
            if (max !== null && max !== undefined && v > max) v = max;
            input.value = String(v);
        });
    }

    function __createSectionTitle(text) {
        var el = document.createElement('div');
        el.textContent = text;
        el.style.cssText =
            'font-size: 10pt;' +
            'font-weight: bold;' +
            'color: ' + __pageFg + ';' +
            'padding-bottom: 6px;' +
            'margin-bottom: 10px;' +
            'border-bottom: 1px solid ' + __pageFg + ';';
        return el;
    }

    function __createFieldRow(labelText, inputEl, labelWidth, extraNode) {
        var row = document.createElement('div');
        row.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'gap: 8px;' +
            'margin-bottom: 8px;' +
            'flex-wrap: nowrap;';

        var label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText =
            'display: inline-block;' +
            'width: ' + labelWidth + 'px;' +
            'min-width: ' + labelWidth + 'px;' +
            'font-size: 9pt;' +
            'color: ' + __pageFg + ';' +
            'white-space: nowrap;' +
            'text-align: left;';
        row.appendChild(label);
        row.appendChild(inputEl);
        if (extraNode) row.appendChild(extraNode);
        return row;
    }

    function __createCheckboxRow(checkboxEl, text) {
        var row = document.createElement('label');
        row.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'justify-content: flex-start;' +
            'gap: 8px;' +
            'margin-bottom: 8px;' +
            'font-size: 9pt;' +
            'color: ' + __pageFg + ';' +
            'cursor: pointer;' +
            'user-select: text;' +
            'line-height: 1;' +
            'min-height: 18px;' +
            'width: 100%;' +
            'box-sizing: border-box;';

        checkboxEl.style.margin = '0';
        checkboxEl.style.position = 'relative';
        checkboxEl.style.top = '0';
        checkboxEl.style.flex = '0 0 auto';
        row.appendChild(checkboxEl);

        var span = document.createElement('span');
        span.textContent = text;
        span.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'line-height: 18px;' +
            'min-height: 18px;' +
            'flex: 0 1 auto;';
        row.appendChild(span);
        return row;
    }

    function __createTabButton(text) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = text;
        btn.style.cssText =
            'width: 100%;' +
            'height: 30px;' +
            'padding: 0 10px;' +
            'border: 1px solid ' + __pageFg + ';' +
            'border-radius: 2px;' +
            'background: transparent;' +
            'color: ' + __pageFg + ';' +
            'font-size: 9pt;' +
            'font-weight: bold;' +
            'text-align: left;' +
            'cursor: pointer;' +
            'box-sizing: border-box;' +
            'box-shadow: none;';
        return btn;
    }

    function __createBulletList(titleText, items) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom: 10px;';

        var title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText =
            'font-size: 9pt;' +
            'font-weight: bold;' +
            'color: ' + __pageFg + ';' +
            'margin-bottom: 6px;';
        wrap.appendChild(title);

        items.forEach(function(item) {
            var line = document.createElement('div');
            line.textContent = '• ' + item;
            line.style.cssText =
                'font-size: 9pt;' +
                'color: ' + __pageFg + ';' +
                'line-height: 1.5;';
            wrap.appendChild(line);
        });

        return wrap;
    }

    function __createInitCard(titleText, deleteItems, keepItems, buttonText) {
        var card = document.createElement('div');
        card.style.cssText =
            'flex: 1 1 calc((100% - 24px) / 3);' +
            'min-width: 260px;' +
            'border: 1px solid ' + __pageFg + ';' +
            'background: ' + __pageBg + ';' +
            'padding: 12px;' +
            'box-sizing: border-box;' +
            'display: flex;' +
            'flex-direction: column;' +
            'align-items: stretch;';

        var title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText =
            'font-size: 10pt;' +
            'font-weight: bold;' +
            'color: ' + __pageFg + ';' +
            'padding-bottom: 6px;' +
            'margin-bottom: 10px;' +
            'border-bottom: 1px solid ' + __pageFg + ';';
        card.appendChild(title);

        var infoRow = document.createElement('div');
        infoRow.style.cssText =
            'display: grid;' +
            'grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);' +
            'column-gap: 24px;' +
            'row-gap: 12px;' +
            'align-items: start;' +
            'width: 100%;' +
            'box-sizing: border-box;';

        var deleteBlock = __createBulletList('將刪除：', deleteItems);
        deleteBlock.style.cssText =
            'min-width: 0;' +
            'width: 100%;' +
            'margin-bottom: 0;' +
            'box-sizing: border-box;';

        var keepBlock = __createBulletList('保留：', keepItems);
        keepBlock.style.cssText =
            'min-width: 0;' +
            'width: 100%;' +
            'margin-bottom: 0;' +
            'box-sizing: border-box;';

        infoRow.appendChild(deleteBlock);
        infoRow.appendChild(keepBlock);
        card.appendChild(infoRow);

        var spacer = document.createElement('div');
        spacer.style.cssText = 'flex: 1;';
        card.appendChild(spacer);

        var footer = document.createElement('div');
        footer.style.cssText =
            'display: flex;' +
            'justify-content: flex-end;' +
            'margin-top: 12px;';

        var btn = document.createElement('button');
        btn.textContent = buttonText;
        __styleButton(btn, true);
        footer.appendChild(btn);
        card.appendChild(footer);

        return { card: card, button: btn };
    }

    var container = document.createElement('div');
    container.className = 'setting-container';
    container.style.cssText =
        'display: none;' +
        'padding: 10px;' +
        'background-color: ' + __pageBg + ';' +
        'border: 1px solid ' + __pageFg + ';' +
        'position: relative;' +
        'user-select: text;';

    var title = document.createElement('div');
    title.textContent = '設置';
    title.style.cssText =
        'font-weight: bold;' +
        'font-size: 10pt;' +
        'color: ' + __pageFg + ';' +
        'margin-bottom: 10px;' +
        'border-bottom: 1px solid ' + __pageFg + ';' +
        'padding-bottom: 4px;';
    container.appendChild(title);

    var shell = document.createElement('div');
    shell.style.cssText =
        'display: flex;' +
        'min-height: 520px;' +
        'border: 1px solid ' + __pageFg + ';' +
        'background: ' + __pageBg + ';';

    var sidebar = document.createElement('div');
    sidebar.style.cssText =
        'width: 200px;' +
        'min-width: 200px;' +
        'border-right: 1px solid ' + __pageFg + ';' +
        'padding: 8px;' +
        'box-sizing: border-box;' +
        'background: ' + __pageBg + ';' +
        'display: flex;' +
        'flex-direction: column;' +
        'gap: 6px;';

    var contentWrap = document.createElement('div');
    contentWrap.style.cssText =
        'flex: 1;' +
        'min-width: 0;' +
        'display: flex;' +
        'flex-direction: column;' +
        'background: ' + __pageBg + ';';

    var contentScroll = document.createElement('div');
    contentScroll.style.cssText =
        'flex: 1;' +
        'padding: 12px;' +
        'box-sizing: border-box;' +
        'overflow-y: auto;' +
        'background: ' + __pageBg + ';';

    var contentFooter = document.createElement('div');
    contentFooter.style.cssText =
        'padding: 0 12px 12px 12px;' +
        'display: flex;' +
        'justify-content: flex-end;' +
        'align-items: flex-end;' +
        'background: transparent;';

    contentWrap.appendChild(contentScroll);
    contentWrap.appendChild(contentFooter);
    shell.appendChild(sidebar);
    shell.appendChild(contentWrap);
    container.appendChild(shell);

    var rootFolderStatus = document.createElement('span');
    rootFolderStatus.style.cssText =
        'font-size: 8pt;' +
        'color: ' + __pageFg + ';' +
        'white-space: nowrap;';

    function refreshRootFolderPermissionStatus() {
        dbGet('handles', 'root_folder_handle').then(function(handle) {
            if (!handle) {
                rootFolderStatus.textContent = '未授權';
                return;
            }
            return handle.queryPermission({ mode: 'read' }).then(function(perm) {
                rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '未授權';
            });
        }).catch(function() {
            rootFolderStatus.textContent = '未授權';
        });
    }

    var inputRootFolder = document.createElement('input');
    inputRootFolder.type = 'text';
    inputRootFolder.value = __settings.customRootFolder || '';
    inputRootFolder.placeholder = '保存後自動要求授權';
    __styleInput(inputRootFolder, '280px');
    inputRootFolder.addEventListener('blur', refreshRootFolderPermissionStatus);

    var inputRetryCount = document.createElement('input');
    inputRetryCount.type = 'number';
    inputRetryCount.min = '1';
    inputRetryCount.max = '10';
    inputRetryCount.value = __settings.retryCount || 3;
    __styleInput(inputRetryCount, '90px');
    __bindNumberRange(inputRetryCount, 1, 10);

    var cbTranslatedDefaultMTL = document.createElement('input');
    cbTranslatedDefaultMTL.type = 'checkbox';
    cbTranslatedDefaultMTL.checked = !!__settings.translatedDefaultMTL;
    __styleCheckbox(cbTranslatedDefaultMTL);

    var cbNonJapaneseDefaultTranslated = document.createElement('input');
    cbNonJapaneseDefaultTranslated.type = 'checkbox';
    cbNonJapaneseDefaultTranslated.checked = !!__settings.nonJapaneseDefaultTranslated;
    __styleCheckbox(cbNonJapaneseDefaultTranslated);

    var cbJapaneseDefaultOfficialTextless = document.createElement('input');
    cbJapaneseDefaultOfficialTextless.type = 'checkbox';
    cbJapaneseDefaultOfficialTextless.checked = !!__settings.japaneseDefaultOfficialTextless;
    __styleCheckbox(cbJapaneseDefaultOfficialTextless);

    var cbDeleteDoubleConfirm = document.createElement('input');
    cbDeleteDoubleConfirm.type = 'checkbox';
    cbDeleteDoubleConfirm.checked = !!__settings.deleteDoubleConfirm;
    __styleCheckbox(cbDeleteDoubleConfirm);

    var cbConfirmBtnColor = document.createElement('input');
    cbConfirmBtnColor.type = 'checkbox';
    cbConfirmBtnColor.checked = __settings.confirmBtnColorChange !== false;
    __styleCheckbox(cbConfirmBtnColor);

    var inputDoubleConfirmMs = document.createElement('input');
    inputDoubleConfirmMs.type = 'number';
    inputDoubleConfirmMs.min = '0';
    inputDoubleConfirmMs.max = '10000';
    inputDoubleConfirmMs.value = __settings.doubleConfirmMs || 1000;
    __styleInput(inputDoubleConfirmMs, '100px');
    __bindNumberRange(inputDoubleConfirmMs, 0, 10000);

    var inputConfirmColorMs = document.createElement('input');
    inputConfirmColorMs.type = 'number';
    inputConfirmColorMs.min = '0';
    inputConfirmColorMs.max = '10000';
    inputConfirmColorMs.value = __settings.confirmBtnColorMs || 1000;
    __styleInput(inputConfirmColorMs, '100px');
    __bindNumberRange(inputConfirmColorMs, 0, 10000);

    var inputConfirmSuccessColor = document.createElement('input');
    inputConfirmSuccessColor.type = 'text';
    inputConfirmSuccessColor.value = _normalizeConfirmFeedbackColorCode(__settings.confirmBtnSuccessColor, '0,255,0');
    inputConfirmSuccessColor.placeholder = '0,255,0';
    __styleInput(inputConfirmSuccessColor, '130px');

    var inputConfirmErrorColor = document.createElement('input');
    inputConfirmErrorColor.type = 'text';
    inputConfirmErrorColor.value = _normalizeConfirmFeedbackColorCode(__settings.confirmBtnErrorColor, '255,0,0');
    inputConfirmErrorColor.placeholder = '255,0,0';
    __styleInput(inputConfirmErrorColor, '130px');

    var inputDoubleConfirmColor = document.createElement('input');
    inputDoubleConfirmColor.type = 'text';
    inputDoubleConfirmColor.value = _normalizeConfirmFeedbackColorCode(__settings.doubleConfirmColor, '255,0,0');
    inputDoubleConfirmColor.placeholder = '255,0,0';
    __styleInput(inputDoubleConfirmColor, '130px');

    var inputPreviewMaxWidth = document.createElement('input');
    inputPreviewMaxWidth.type = 'number';
    inputPreviewMaxWidth.min = '1';
    inputPreviewMaxWidth.max = '9999';
    inputPreviewMaxWidth.value = __settings.previewMaxWidth || 800;
    __styleInput(inputPreviewMaxWidth, '90px');
    __bindNumberRange(inputPreviewMaxWidth, 1, 9999);

    var inputPreviewMaxHeight = document.createElement('input');
    inputPreviewMaxHeight.type = 'number';
    inputPreviewMaxHeight.min = '1';
    inputPreviewMaxHeight.max = '9999';
    inputPreviewMaxHeight.value = __settings.previewMaxHeight || 800;
    __styleInput(inputPreviewMaxHeight, '90px');
    __bindNumberRange(inputPreviewMaxHeight, 1, 9999);

    var __cbGalleryFolderManagerCopyWithExtension = document.createElement('input');
    __cbGalleryFolderManagerCopyWithExtension.type = 'checkbox';
    __cbGalleryFolderManagerCopyWithExtension.checked = __settings.galleryFolderManagerCopyWithExtension !== false;
    __styleCheckbox(__cbGalleryFolderManagerCopyWithExtension);

    var cbAutoSwitchDictDropdown = document.createElement('input');
    cbAutoSwitchDictDropdown.type = 'checkbox';
    cbAutoSwitchDictDropdown.checked = __settings.autoSwitchDictDropdown !== false;
    __styleCheckbox(cbAutoSwitchDictDropdown);

    var inputDictPriorityPadLength = document.createElement('input');
    inputDictPriorityPadLength.type = 'number';
    inputDictPriorityPadLength.min = '1';
    inputDictPriorityPadLength.max = '20';
    inputDictPriorityPadLength.value = __settings.dictPriorityPadLength || 5;
    __styleInput(inputDictPriorityPadLength, '90px');
    __bindNumberRange(inputDictPriorityPadLength, 1, 20);

    var cbShowDebugLogs = document.createElement('input');
    cbShowDebugLogs.type = 'checkbox';
    cbShowDebugLogs.checked = !!__settings.showDebugLogsInBrowserConsole;
    __styleCheckbox(cbShowDebugLogs);

    var cbLogToBrowserConsole = document.createElement('input');
    cbLogToBrowserConsole.type = 'checkbox';
    cbLogToBrowserConsole.checked = !!__settings.logToBrowserConsole;
    __styleCheckbox(cbLogToBrowserConsole);

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

    var currentPriorities = __settings.optionPriorities || {};
    var priorityList = priorityKeys.map(function(item) {
        return {
            key: item.key,
            label: item.label,
            tagMain: item.tagMain,
            tagJp: item.tagJp,
            priority: currentPriorities[item.key] || 99
        };
    });
    priorityList.sort(function(a, b) { return a.priority - b.priority; });

    var priorityTable = document.createElement('div');
    priorityTable.style.cssText =
        'max-width: 520px;' +
        'border: 1px solid ' + __pageFg + ';' +
        'background: ' + __pageBg + ';';

    function rebuildPriorityList() {
        while (priorityTable.firstChild) priorityTable.removeChild(priorityTable.firstChild);

        priorityList.forEach(function(item, index) {
            var row = document.createElement('div');
            row.style.cssText =
                'display: flex;' +
                'align-items: center;' +
                'gap: 8px;' +
                'padding: 6px 8px;' +
                'border-bottom: ' + (index < priorityList.length - 1 ? ('1px solid ' + __pageFg) : 'none') + ';' +
                'background: ' + __pageBg + ';';

            var indexLabel = document.createElement('span');
            indexLabel.textContent = String(index + 1);
            indexLabel.style.cssText =
                'display: inline-block;' +
                'width: 24px;' +
                'min-width: 24px;' +
                'font-size: 9pt;' +
                'font-weight: bold;' +
                'color: ' + __pageFg + ';' +
                'text-align: right;';
            row.appendChild(indexLabel);

            var label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText =
                'flex: 1;' +
                'min-width: 0;' +
                'font-size: 9pt;' +
                'color: ' + __pageFg + ';' +
                'word-break: break-all;';
            row.appendChild(label);

            var upBtn = document.createElement('button');
            upBtn.textContent = '↑';
            __styleButton(upBtn, false);
            upBtn.style.width = '28px';
            upBtn.style.padding = '0';
            if (index === 0) {
                upBtn.style.opacity = '0.35';
                upBtn.style.cursor = 'default';
            }
            upBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === 0) return;
                var tmp = priorityList[index];
                priorityList[index] = priorityList[index - 1];
                priorityList[index - 1] = tmp;
                rebuildPriorityList();
            });
            row.appendChild(upBtn);

            var downBtn = document.createElement('button');
            downBtn.textContent = '↓';
            __styleButton(downBtn, false);
            downBtn.style.width = '28px';
            downBtn.style.padding = '0';
            if (index === priorityList.length - 1) {
                downBtn.style.opacity = '0.35';
                downBtn.style.cursor = 'default';
            }
            downBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === priorityList.length - 1) return;
                var tmp2 = priorityList[index];
                priorityList[index] = priorityList[index + 1];
                priorityList[index + 1] = tmp2;
                rebuildPriorityList();
            });
            row.appendChild(downBtn);

            priorityTable.appendChild(row);
        });
    }

    rebuildPriorityList();

    var generalPanel = document.createElement('div');
    generalPanel.style.cssText = 'display: none;';
    generalPanel.appendChild(__createSectionTitle('通用設置'));
    generalPanel.appendChild(__createFieldRow('自定義根文件夾', inputRootFolder, 150, rootFolderStatus));
    generalPanel.appendChild(__createFieldRow('創建失敗重試次數', inputRetryCount, 150));
    refreshRootFolderPermissionStatus();

    var interfacePanel = document.createElement('div');
    interfacePanel.style.cssText = 'display: none;';
    interfacePanel.appendChild(__createSectionTitle('介面設置'));
    interfacePanel.appendChild(__createCheckboxRow(cbTranslatedDefaultMTL, '勾選 Translated 時默認啟用 MTL'));
    interfacePanel.appendChild(__createCheckboxRow(cbNonJapaneseDefaultTranslated, '選擇除 Japanese 的語言時默認啟用 Translated'));
    interfacePanel.appendChild(__createCheckboxRow(cbJapaneseDefaultOfficialTextless, '選擇 Japanese 時默認啟用 Official / Textless'));
    interfacePanel.appendChild(__createCheckboxRow(cbDeleteDoubleConfirm, '刪除時需要雙重確認'));
    interfacePanel.appendChild(__createCheckboxRow(cbConfirmBtnColor, '按鈕是否變色'));
    interfacePanel.appendChild(__createFieldRow('雙重確認時間 (毫秒)', inputDoubleConfirmMs, 190));
    interfacePanel.appendChild(__createFieldRow('按鈕變色時長 (毫秒)', inputConfirmColorMs, 190));
    interfacePanel.appendChild(__createFieldRow('按鈕成功顏色RGB值', inputConfirmSuccessColor, 190));
    interfacePanel.appendChild(__createFieldRow('按鈕失敗顏色RGB值', inputConfirmErrorColor, 190));
    interfacePanel.appendChild(__createFieldRow('雙重確認變色顏色RGB值', inputDoubleConfirmColor, 190));

    var specialSizeRow = document.createElement('div');
    specialSizeRow.style.cssText =
        'display: flex;' +
        'align-items: center;' +
        'gap: 10px;' +
        'flex-wrap: wrap;' +
        'margin-top: 2px;';
    var widthLabel = document.createElement('span');
    widthLabel.textContent = '預覧圖片最大寬度';
    widthLabel.style.cssText = 'font-size: 9pt; color: ' + __pageFg + '; white-space: nowrap;';
    var heightLabel = document.createElement('span');
    heightLabel.textContent = '預覧圖片最大高度';
    heightLabel.style.cssText = 'font-size: 9pt; color: ' + __pageFg + '; white-space: nowrap;';
    specialSizeRow.appendChild(widthLabel);
    specialSizeRow.appendChild(inputPreviewMaxWidth);
    specialSizeRow.appendChild(heightLabel);
    specialSizeRow.appendChild(inputPreviewMaxHeight);
    interfacePanel.appendChild(specialSizeRow);

    var galleryFolderManagerPanel = document.createElement('div');
    galleryFolderManagerPanel.style.cssText = 'display: none;';
    galleryFolderManagerPanel.appendChild(__createSectionTitle('Gallery Folder Manager設置'));
    galleryFolderManagerPanel.appendChild(__createCheckboxRow(__cbGalleryFolderManagerCopyWithExtension, '是否複製副檔名'));

    var dictPanel = document.createElement('div');
    dictPanel.style.cssText = 'display: none;';
    dictPanel.appendChild(__createSectionTitle('Dict Manager設置'));
    dictPanel.appendChild(__createCheckboxRow(cbAutoSwitchDictDropdown, 'Dict Manager點擊時頂部下拉清單是否自動切換'));
    dictPanel.appendChild(__createFieldRow('優先度固定補零長度', inputDictPriorityPadLength, 170));

    var priorityPanel = document.createElement('div');
    priorityPanel.style.cssText = 'display: none;';
    priorityPanel.appendChild(__createSectionTitle('特殊標記優先度設置'));

    var priorityLabel = document.createElement('div');
    priorityLabel.textContent = '特殊標記優先度';
    priorityLabel.style.cssText =
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'color: ' + __pageFg + ';' +
        'margin-bottom: 10px;';
    priorityPanel.appendChild(priorityLabel);

    var priorityNote = document.createElement('div');
    priorityNote.textContent = '數字越小越優先，使用上下按鈕調整順序。';
    priorityNote.style.cssText =
        'font-size: 8.5pt;' +
        'color: ' + __pageFg + ';' +
        'margin-bottom: 10px;';
    priorityPanel.appendChild(priorityNote);
    priorityPanel.appendChild(priorityTable);

    var debugPanel = document.createElement('div');
    debugPanel.style.cssText = 'display: none;';
    debugPanel.appendChild(__createSectionTitle('偵錯設置'));
    debugPanel.appendChild(__createCheckboxRow(cbShowDebugLogs, '顯示debug訊息'));
    debugPanel.appendChild(__createCheckboxRow(cbLogToBrowserConsole, '在瀏覽器主控台中輸出控制台訊息'));

    var initPanel = document.createElement('div');
    initPanel.style.cssText = 'display: none;';
    initPanel.appendChild(__createSectionTitle('初始化'));

    var cardsWrap = document.createElement('div');
    cardsWrap.style.cssText =
        'display: flex;' +
        'gap: 12px;' +
        'flex-wrap: wrap;' +
        'align-items: stretch;';

    var clearCacheCard = __createInitCard(
        '清理緩存',
        ['已保存的圖庫資料', '文件列表', '評論模板', '掃描的文件夾', '本地文件夾授權', '所有待處理任務', '外部字典緩存'],
        ['腳本設置', '本地自定義字典'],
        '清理緩存'
    );

    var resetDictCard = __createInitCard(
        '重置字典',
        ['外部字典緩存'],
        ['所有用戶數據', '腳本設置', '本地自定義字典'],
        '重置字典'
    );

    var resetSettingsCard = __createInitCard(
        '重置設置',
        ['本地設置'],
        ['已保存的圖庫資料', '本地自定義字典', '外部字典緩存'],
        '重置設置'
    );

    cardsWrap.appendChild(clearCacheCard.card);
    cardsWrap.appendChild(resetDictCard.card);
    cardsWrap.appendChild(resetSettingsCard.card);
    initPanel.appendChild(cardsWrap);

    var saveSettingsBtn = document.createElement('button');
    saveSettingsBtn.textContent = '保存設置';
    __styleButton(saveSettingsBtn, true);
    contentFooter.appendChild(saveSettingsBtn);

    contentScroll.appendChild(generalPanel);
    contentScroll.appendChild(interfacePanel);
    contentScroll.appendChild(galleryFolderManagerPanel);
    contentScroll.appendChild(dictPanel);
    contentScroll.appendChild(priorityPanel);
    contentScroll.appendChild(debugPanel);
    contentScroll.appendChild(initPanel);

    var tabs = [
        { key: 'general', label: '通用設置', panel: generalPanel },
        { key: 'interface', label: '介面設置', panel: interfacePanel },
        { key: 'galleryFolderManager', label: 'Gallery Folder Manager設置', panel: galleryFolderManagerPanel },
        { key: 'dict', label: 'Dict Manager設置', panel: dictPanel },
        { key: 'priority', label: '特殊標記優先度設置', panel: priorityPanel },
        { key: 'debug', label: '偵錯設置', panel: debugPanel },
        { key: 'init', label: '初始化', panel: initPanel }
    ];

    var tabButtons = {};

    function setActiveTab(tabKey) {
        tabs.forEach(function(tab) {
            var active = tab.key === tabKey;
            tab.panel.style.display = active ? 'block' : 'none';
            if (tabButtons[tab.key]) {
                tabButtons[tab.key].style.background = active ? __activeBg : 'transparent';
                tabButtons[tab.key].style.color = active ? __activeFg : __pageFg;
            }
        });
        contentFooter.style.display = tabKey === 'init' ? 'none' : 'flex';
    }

    tabs.forEach(function(tab) {
        var btn = __createTabButton(tab.label);
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            setActiveTab(tab.key);
        });
        sidebar.appendChild(btn);
        tabButtons[tab.key] = btn;
    });

    setActiveTab('general');

    clearCacheCard.button.addEventListener('click', function(e) {
        e.preventDefault();
        var warning = '警告：此操作無法復原。\n\n將刪除：\n• 已保存的圖庫資料\n• 文件列表\n• 評論模板\n• 掃描的文件夾\n• 本地文件夾授權\n• 所有待處理任務\n• 外部字典緩存\n\n保留：\n• 腳本設置\n• 本地自定義字典\n\n確定要清理緩存嗎？';
        if (!confirm(warning)) return;

        var gmKeys = [
            'saved_galleries', 'file_lists', 'comment_templates',
            'scanned_folders', 'local_folders',
            'pending_create', 'pending_create_queue', 'pending_upload',
            'create_success'
        ];
        gmKeys.forEach(function(key) {
            GM_deleteValue(key);
        });
        opLog('清理緩存', { type: 'GM + IndexedDB' });

        var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
        dbReq.onsuccess = function() {
            flowLog('ClearCache', 'IndexedDB 已刪除');
            var unpublishedSection = document.querySelector('.s[data-custom="true"]');
            if (unpublishedSection) unpublishedSection.remove();
            clearCacheCard.button.textContent = '已清空 ✓';
            setTimeout(function() {
                clearCacheCard.button.textContent = '清理緩存';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ClearCache', 'IndexedDB 刪除失敗', ev.target.error);
            clearCacheCard.button.textContent = '清空失敗';
            setTimeout(function() {
                clearCacheCard.button.textContent = '清理緩存';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ClearCache', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            clearCacheCard.button.textContent = '請關閉其他分頁';
            setTimeout(function() {
                clearCacheCard.button.textContent = '清理緩存';
            }, 3000);
        };
    });

    resetDictCard.button.addEventListener('click', function(e) {
        e.preventDefault();
        var warning = '警告：此操作無法復原。\n\n將刪除：\n• 外部字典緩存\n\n保留：\n• 所有用戶數據\n• 腳本設置\n• 本地自定義字典\n\n確定要重置字典嗎？';
        if (!confirm(warning)) return;

        var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
        dbReq.onsuccess = function() {
            opLog('重置字典', { scope: 'IndexedDB' });
            resetDictCard.button.textContent = '已重置 ✓';
            setTimeout(function() {
                resetDictCard.button.textContent = '重置字典';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ResetDict', 'IndexedDB 刪除失敗', ev.target.error);
            resetDictCard.button.textContent = '重置失敗';
            setTimeout(function() {
                resetDictCard.button.textContent = '重置字典';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ResetDict', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            resetDictCard.button.textContent = '請關閉其他分頁';
            setTimeout(function() {
                resetDictCard.button.textContent = '重置字典';
            }, 3000);
        };
    });

    resetSettingsCard.button.addEventListener('click', function(e) {
        e.preventDefault();
        var warning = '警告：此操作無法復原。\n\n將刪除：\n• 本地設置\n\n保留：\n• 已保存的圖庫資料\n• 本地自定義字典\n• 外部字典緩存\n\n確定要重置設置嗎？';
        if (!confirm(warning)) return;

        try {
            GM_deleteValue('fifybuj_settings');
            var defaultSettings = getDefaultSettings();
            GM_setValue('fifybuj_settings', defaultSettings);
            currentSettings = defaultSettings;
            opLog('重置設置', defaultSettings);
            resetSettingsCard.button.textContent = '已重置 ✓';
            setTimeout(function() {
                resetSettingsCard.button.textContent = '重置設置';
                window.location.reload();
            }, 2000);
        } catch (err) {
            errorLog('ResetSettings', '重置失敗', err);
            resetSettingsCard.button.textContent = '重置失敗';
            setTimeout(function() {
                resetSettingsCard.button.textContent = '重置設置';
            }, 2000);
        }
    });

    saveSettingsBtn.addEventListener('click', function(e) {
        e.preventDefault();

        var newPriorities = {};
        priorityList.forEach(function(item, index) {
            newPriorities[item.key] = index + 1;
        });

        var newRootFolder = inputRootFolder.value.trim();
        var newSettings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe(), {
            customRootFolder: newRootFolder,
            retryCount: parseInt(inputRetryCount.value, 10) || 3,
            translatedDefaultMTL: cbTranslatedDefaultMTL.checked,
            nonJapaneseDefaultTranslated: cbNonJapaneseDefaultTranslated.checked,
            japaneseDefaultOfficialTextless: cbJapaneseDefaultOfficialTextless.checked,
            autoSwitchDictDropdown: cbAutoSwitchDictDropdown.checked,
            showDebugLogsInBrowserConsole: cbShowDebugLogs.checked,
            dictPriorityPadLength: parseInt(inputDictPriorityPadLength.value, 10) || 5,
            deleteDoubleConfirm: cbDeleteDoubleConfirm.checked,
            doubleConfirmMs: parseInt(inputDoubleConfirmMs.value, 10) || 1000,
            logToBrowserConsole: cbLogToBrowserConsole.checked,
            confirmBtnColorChange: cbConfirmBtnColor.checked,
            confirmBtnColorMs: parseInt(inputConfirmColorMs.value, 10) || 1000,
            confirmBtnSuccessColor: _normalizeConfirmFeedbackColorCode(inputConfirmSuccessColor.value, '0,255,0'),
            confirmBtnErrorColor: _normalizeConfirmFeedbackColorCode(inputConfirmErrorColor.value, '255,0,0'),
            doubleConfirmColor: _normalizeConfirmFeedbackColorCode(inputDoubleConfirmColor.value, '255,0,0'),
            previewMaxWidth: parseInt(inputPreviewMaxWidth.value, 10) || 800,
            previewMaxHeight: parseInt(inputPreviewMaxHeight.value, 10) || 800,
            galleryFolderManagerCopyWithExtension: __cbGalleryFolderManagerCopyWithExtension.checked,
            optionPriorities: newPriorities
        });

        saveSettings(newSettings);

        if (newRootFolder && window.showDirectoryPicker) {
            rootFolderStatus.textContent = '等待授權...';
            window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' })
                .then(function(handle) {
                    return dbSet('handles', 'root_folder_handle', handle).then(function() {
                        return handle.queryPermission({ mode: 'read' });
                    }).then(function(perm) {
                        rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '授權失敗';
                    });
                })
                .catch(function(err) {
                    rootFolderStatus.textContent = err.name !== 'AbortError' ? '授權失敗' : '已取消';
                });
        } else {
            refreshRootFolderPermissionStatus();
        }

        flashButtonSavedState(saveSettingsBtn, '已保存 ✓', '保存設置', 1500);
    });

    return container;
}

function __createSettingPanel_legacy(sectionDiv) {
    return __createSettingPanelSidebar_legacy_v6(sectionDiv);
}

function __createSettingPanelSidebar_legacy_v6(sectionDiv) {
    var __panelBg = '#F5E6D3';
    var __panelFg = '#4A3728';
    var __activeBg = '#4A3728';
    var __activeFg = '#F5E6D3';

    function __styleInput(el, width) {
        if (!el) return el;
        el.style.cssText =
            'width: ' + (width || '220px') + ';' +
            'height: 24px;' +
            'box-sizing: border-box;' +
            'border: 1px solid ' + __panelFg + ';' +
            'background: transparent;' +
            'color: ' + __panelFg + ';' +
            'font-size: 9pt;' +
            'padding: 0 6px;' +
            'border-radius: 2px;' +
            'outline: none;' +
            'box-shadow: none;';
        return el;
    }

    function __styleButton(btn, primary) {
        if (!btn) return btn;
        btn.style.cssText =
            'height: 26px;' +
            'padding: 0 12px;' +
            'box-sizing: border-box;' +
            'border: 1px solid ' + __panelFg + ';' +
            'border-radius: 2px;' +
            'cursor: pointer;' +
            'font-size: 9pt;' +
            'font-weight: bold;' +
            'line-height: 24px;' +
            'box-shadow: none;' +
            'background: ' + (primary ? __panelFg : 'transparent') + ';' +
            'color: ' + (primary ? __panelBg : __panelFg) + ';';
        return btn;
    }

    function __styleCheckbox(cb) {
        if (!cb) return cb;
        cb.style.cssText =
            'margin: 0;' +
            'width: 14px;' +
            'height: 14px;' +
            'accent-color: ' + __panelFg + ';' +
            'flex: 0 0 auto;';
        return cb;
    }

    function __bindNumberRange(input, min, max) {
        if (!input) return;
        input.addEventListener('input', function() {
            var raw = String(input.value || '').trim();
            if (raw === '') return;
            var v = parseInt(raw, 10);
            if (isNaN(v)) {
                input.value = '';
                return;
            }
            if (min !== null && min !== undefined && v < min) v = min;
            if (max !== null && max !== undefined && v > max) v = max;
            input.value = String(v);
        });
    }

    function __createSectionTitle(text) {
        var el = document.createElement('div');
        el.textContent = text;
        el.style.cssText =
            'font-size: 10pt;' +
            'font-weight: bold;' +
            'color: ' + __panelFg + ';' +
            'padding-bottom: 6px;' +
            'margin-bottom: 10px;' +
            'border-bottom: 1px solid ' + __panelFg + ';';
        return el;
    }

    function __createFieldRow(labelText, inputEl, labelWidth, extraNode) {
        var row = document.createElement('div');
        row.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'gap: 8px;' +
            'margin-bottom: 8px;' +
            'flex-wrap: nowrap;';

        var label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText =
            'display: inline-block;' +
            'width: ' + labelWidth + 'px;' +
            'min-width: ' + labelWidth + 'px;' +
            'font-size: 9pt;' +
            'color: ' + __panelFg + ';' +
            'white-space: nowrap;' +
            'text-align: left;';
        row.appendChild(label);
        row.appendChild(inputEl);

        if (extraNode) row.appendChild(extraNode);
        return row;
    }

    function __createCheckboxRow(checkboxEl, text) {
        var row = document.createElement('label');
        row.style.cssText =
            'display: flex;' +
            'align-items: center;' +
            'gap: 8px;' +
            'margin-bottom: 8px;' +
            'font-size: 9pt;' +
            'color: ' + __panelFg + ';' +
            'cursor: pointer;' +
            'user-select: text;';
        row.appendChild(checkboxEl);

        var span = document.createElement('span');
        span.textContent = text;
        span.style.cssText = 'display: inline-block; line-height: 1.4;';
        row.appendChild(span);
        return row;
    }

    function __createTabButton(text) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = text;
        btn.style.cssText =
            'width: 100%;' +
            'height: 30px;' +
            'padding: 0 10px;' +
            'border: 1px solid ' + __panelFg + ';' +
            'border-radius: 2px;' +
            'background: transparent;' +
            'color: ' + __panelFg + ';' +
            'font-size: 9pt;' +
            'font-weight: bold;' +
            'text-align: left;' +
            'cursor: pointer;' +
            'box-sizing: border-box;' +
            'box-shadow: none;';
        return btn;
    }

    var __settings = loadSettings();

    var __container = document.createElement('div');
    __container.className = 'setting-container';
    __container.style.cssText =
        'display: none;' +
        'padding: 10px;' +
        'background-color: ' + __panelBg + ';' +
        'border: 1px solid ' + __panelFg + ';' +
        'position: relative;' +
        'user-select: text;';

    var __title = document.createElement('div');
    __title.textContent = '設置';
    __title.style.cssText =
        'font-weight: bold;' +
        'font-size: 10pt;' +
        'color: ' + __panelFg + ';' +
        'margin-bottom: 10px;' +
        'border-bottom: 1px solid ' + __panelFg + ';' +
        'padding-bottom: 4px;';
    __container.appendChild(__title);

    var __shell = document.createElement('div');
    __shell.style.cssText =
        'display: flex;' +
        'min-height: 520px;' +
        'border: 1px solid ' + __panelFg + ';' +
        'background: ' + __panelBg + ';';

    var __sidebar = document.createElement('div');
    __sidebar.style.cssText =
        'width: 200px;' +
        'min-width: 200px;' +
        'border-right: 1px solid ' + __panelFg + ';' +
        'padding: 8px;' +
        'box-sizing: border-box;' +
        'background: ' + __panelBg + ';' +
        'display: flex;' +
        'flex-direction: column;' +
        'gap: 6px;';

    var __contentWrap = document.createElement('div');
    __contentWrap.style.cssText =
        'flex: 1;' +
        'min-width: 0;' +
        'display: flex;' +
        'flex-direction: column;' +
        'background: ' + __panelBg + ';';

    var __contentScroll = document.createElement('div');
    __contentScroll.style.cssText =
        'flex: 1;' +
        'padding: 12px;' +
        'box-sizing: border-box;' +
        'overflow-y: auto;' +
        'background: ' + __panelBg + ';';

    var __contentFooter = document.createElement('div');
    __contentFooter.style.cssText =
        'padding: 10px 12px;' +
        'border-top: 1px solid ' + __panelFg + ';' +
        'display: flex;' +
        'justify-content: flex-end;' +
        'align-items: center;' +
        'background: ' + __panelBg + ';';

    __contentWrap.appendChild(__contentScroll);
    __contentWrap.appendChild(__contentFooter);
    __shell.appendChild(__sidebar);
    __shell.appendChild(__contentWrap);
    __container.appendChild(__shell);

    var __rootFolderStatus = document.createElement('span');
    __rootFolderStatus.style.cssText =
        'font-size: 8pt;' +
        'color: ' + __panelFg + ';' +
        'white-space: nowrap;';

    function __refreshRootFolderPermissionStatus() {
        dbGet('handles', 'root_folder_handle').then(function(handle) {
            if (!handle) {
                __rootFolderStatus.textContent = '未授權';
                return;
            }
            return handle.queryPermission({ mode: 'read' }).then(function(perm) {
                __rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '未授權';
            });
        }).catch(function() {
            __rootFolderStatus.textContent = '未授權';
        });
    }

    var __inputRootFolder = document.createElement('input');
    __inputRootFolder.type = 'text';
    __inputRootFolder.value = __settings.customRootFolder || '';
    __inputRootFolder.placeholder = '保存後自動要求授權';
    __styleInput(__inputRootFolder, '280px');
    __inputRootFolder.addEventListener('blur', __refreshRootFolderPermissionStatus);

    var __inputRetryCount = document.createElement('input');
    __inputRetryCount.type = 'number';
    __inputRetryCount.min = '1';
    __inputRetryCount.max = '10';
    __inputRetryCount.value = __settings.retryCount || 3;
    __styleInput(__inputRetryCount, '90px');
    __bindNumberRange(__inputRetryCount, 1, 10);

    var __cbTranslatedDefaultMTL = document.createElement('input');
    __cbTranslatedDefaultMTL.type = 'checkbox';
    __cbTranslatedDefaultMTL.checked = !!__settings.translatedDefaultMTL;
    __styleCheckbox(__cbTranslatedDefaultMTL);

    var __cbNonJapaneseDefaultTranslated = document.createElement('input');
    __cbNonJapaneseDefaultTranslated.type = 'checkbox';
    __cbNonJapaneseDefaultTranslated.checked = !!__settings.nonJapaneseDefaultTranslated;
    __styleCheckbox(__cbNonJapaneseDefaultTranslated);

    var __cbJapaneseDefaultOfficialTextless = document.createElement('input');
    __cbJapaneseDefaultOfficialTextless.type = 'checkbox';
    __cbJapaneseDefaultOfficialTextless.checked = !!__settings.japaneseDefaultOfficialTextless;
    __styleCheckbox(__cbJapaneseDefaultOfficialTextless);

    var __cbDeleteDoubleConfirm = document.createElement('input');
    __cbDeleteDoubleConfirm.type = 'checkbox';
    __cbDeleteDoubleConfirm.checked = !!__settings.deleteDoubleConfirm;
    __styleCheckbox(__cbDeleteDoubleConfirm);

    var __cbConfirmBtnColor = document.createElement('input');
    __cbConfirmBtnColor.type = 'checkbox';
    __cbConfirmBtnColor.checked = __settings.confirmBtnColorChange !== false;
    __styleCheckbox(__cbConfirmBtnColor);

    var __inputDoubleConfirmMs = document.createElement('input');
    __inputDoubleConfirmMs.type = 'number';
    __inputDoubleConfirmMs.min = '0';
    __inputDoubleConfirmMs.max = '10000';
    __inputDoubleConfirmMs.value = __settings.doubleConfirmMs || 1000;
    __styleInput(__inputDoubleConfirmMs, '100px');
    __bindNumberRange(__inputDoubleConfirmMs, 0, 10000);

    var __inputConfirmColorMs = document.createElement('input');
    __inputConfirmColorMs.type = 'number';
    __inputConfirmColorMs.min = '0';
    __inputConfirmColorMs.max = '10000';
    __inputConfirmColorMs.value = __settings.confirmBtnColorMs || 1000;
    __styleInput(__inputConfirmColorMs, '100px');
    __bindNumberRange(__inputConfirmColorMs, 0, 10000);

    var __inputPreviewMaxWidth = document.createElement('input');
    __inputPreviewMaxWidth.type = 'number';
    __inputPreviewMaxWidth.min = '1';
    __inputPreviewMaxWidth.max = '9999';
    __inputPreviewMaxWidth.value = __settings.previewMaxWidth || 800;
    __styleInput(__inputPreviewMaxWidth, '90px');
    __bindNumberRange(__inputPreviewMaxWidth, 1, 9999);

    var __inputPreviewMaxHeight = document.createElement('input');
    __inputPreviewMaxHeight.type = 'number';
    __inputPreviewMaxHeight.min = '1';
    __inputPreviewMaxHeight.max = '9999';
    __inputPreviewMaxHeight.value = __settings.previewMaxHeight || 800;
    __styleInput(__inputPreviewMaxHeight, '90px');
    __bindNumberRange(__inputPreviewMaxHeight, 1, 9999);

    var __cbAutoSwitchDictDropdown = document.createElement('input');
    __cbAutoSwitchDictDropdown.type = 'checkbox';
    __cbAutoSwitchDictDropdown.checked = __settings.autoSwitchDictDropdown !== false;
    __styleCheckbox(__cbAutoSwitchDictDropdown);

    var __inputDictPriorityPadLength = document.createElement('input');
    __inputDictPriorityPadLength.type = 'number';
    __inputDictPriorityPadLength.min = '1';
    __inputDictPriorityPadLength.max = '20';
    __inputDictPriorityPadLength.value = __settings.dictPriorityPadLength || 5;
    __styleInput(__inputDictPriorityPadLength, '90px');
    __bindNumberRange(__inputDictPriorityPadLength, 1, 20);

    var __cbShowDebugLogs = document.createElement('input');
    __cbShowDebugLogs.type = 'checkbox';
    __cbShowDebugLogs.checked = !!__settings.showDebugLogsInBrowserConsole;
    __styleCheckbox(__cbShowDebugLogs);

    var __cbLogToBrowserConsole = document.createElement('input');
    __cbLogToBrowserConsole.type = 'checkbox';
    __cbLogToBrowserConsole.checked = !!__settings.logToBrowserConsole;
    __styleCheckbox(__cbLogToBrowserConsole);

    var __priorityKeys = [
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

    var __currentPriorities = __settings.optionPriorities || {};
    var __priorityList = __priorityKeys.map(function(item) {
        return {
            key: item.key,
            label: item.label,
            tagMain: item.tagMain,
            tagJp: item.tagJp,
            priority: __currentPriorities[item.key] || 99
        };
    });
    __priorityList.sort(function(a, b) { return a.priority - b.priority; });

    var __priorityTable = document.createElement('div');
    __priorityTable.style.cssText =
        'max-width: 520px;' +
        'border: 1px solid ' + __panelFg + ';' +
        'background: ' + __panelBg + ';';

    function __rebuildPriorityList() {
        while (__priorityTable.firstChild) __priorityTable.removeChild(__priorityTable.firstChild);

        __priorityList.forEach(function(item, index) {
            var row = document.createElement('div');
            row.style.cssText =
                'display: flex;' +
                'align-items: center;' +
                'gap: 8px;' +
                'padding: 6px 8px;' +
                'border-bottom: ' + (index < __priorityList.length - 1 ? ('1px solid ' + __panelFg) : 'none') + ';' +
                'background: ' + __panelBg + ';';

            var indexLabel = document.createElement('span');
            indexLabel.textContent = String(index + 1);
            indexLabel.style.cssText =
                'display: inline-block;' +
                'width: 24px;' +
                'min-width: 24px;' +
                'font-size: 9pt;' +
                'font-weight: bold;' +
                'color: ' + __panelFg + ';' +
                'text-align: right;';
            row.appendChild(indexLabel);

            var label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText =
                'flex: 1;' +
                'min-width: 0;' +
                'font-size: 9pt;' +
                'color: ' + __panelFg + ';' +
                'word-break: break-all;';
            row.appendChild(label);

            var upBtn = document.createElement('button');
            upBtn.textContent = '↑';
            __styleButton(upBtn, false);
            upBtn.style.width = '28px';
            upBtn.style.padding = '0';
            if (index === 0) {
                upBtn.style.opacity = '0.35';
                upBtn.style.cursor = 'default';
            }
            upBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === 0) return;
                var tmp = __priorityList[index];
                __priorityList[index] = __priorityList[index - 1];
                __priorityList[index - 1] = tmp;
                __rebuildPriorityList();
            });
            row.appendChild(upBtn);

            var downBtn = document.createElement('button');
            downBtn.textContent = '↓';
            __styleButton(downBtn, false);
            downBtn.style.width = '28px';
            downBtn.style.padding = '0';
            if (index === __priorityList.length - 1) {
                downBtn.style.opacity = '0.35';
                downBtn.style.cursor = 'default';
            }
            downBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === __priorityList.length - 1) return;
                var tmp2 = __priorityList[index];
                __priorityList[index] = __priorityList[index + 1];
                __priorityList[index + 1] = tmp2;
                __rebuildPriorityList();
            });
            row.appendChild(downBtn);

            __priorityTable.appendChild(row);
        });
    }

    __rebuildPriorityList();

    var __generalPanel = document.createElement('div');
    __generalPanel.style.cssText = 'display: none;';
    __generalPanel.appendChild(__createSectionTitle('通用設置'));
    __generalPanel.appendChild(__createFieldRow('自定義根文件夾', __inputRootFolder, 150, __rootFolderStatus));
    __generalPanel.appendChild(__createFieldRow('創建失敗重試次數', __inputRetryCount, 150));
    __refreshRootFolderPermissionStatus();

    var __interfacePanel = document.createElement('div');
    __interfacePanel.style.cssText = 'display: none;';
    __interfacePanel.appendChild(__createSectionTitle('介面設置'));
    __interfacePanel.appendChild(__createCheckboxRow(__cbTranslatedDefaultMTL, '勾選 Translated 時默認啟用 MTL'));
    __interfacePanel.appendChild(__createCheckboxRow(__cbNonJapaneseDefaultTranslated, '選擇除 Japanese 的語言時默認啟用 Translated'));
    __interfacePanel.appendChild(__createCheckboxRow(__cbJapaneseDefaultOfficialTextless, '選擇 Japanese 時默認啟用 Official / Textless'));
    __interfacePanel.appendChild(__createCheckboxRow(__cbDeleteDoubleConfirm, '刪除時需要雙重確認'));
    __interfacePanel.appendChild(__createCheckboxRow(__cbConfirmBtnColor, '確認按鈕是否變色'));
    __interfacePanel.appendChild(__createFieldRow('雙重確認時間 (毫秒)', __inputDoubleConfirmMs, 190));
    __interfacePanel.appendChild(__createFieldRow('確認按鈕變色時長 (毫秒)', __inputConfirmColorMs, 190));

    var __specialSizeRow = document.createElement('div');
    __specialSizeRow.style.cssText =
        'display: flex;' +
        'align-items: center;' +
        'gap: 10px;' +
        'flex-wrap: wrap;' +
        'margin-top: 2px;';
    var __widthLabel = document.createElement('span');
    __widthLabel.textContent = '預覧圖片最大寬度';
    __widthLabel.style.cssText = 'font-size: 9pt; color: ' + __panelFg + '; white-space: nowrap;';
    var __heightLabel = document.createElement('span');
    __heightLabel.textContent = '預覧圖片最大高度';
    __heightLabel.style.cssText = 'font-size: 9pt; color: ' + __panelFg + '; white-space: nowrap;';
    __specialSizeRow.appendChild(__widthLabel);
    __specialSizeRow.appendChild(__inputPreviewMaxWidth);
    __specialSizeRow.appendChild(__heightLabel);
    __specialSizeRow.appendChild(__inputPreviewMaxHeight);
    __interfacePanel.appendChild(__specialSizeRow);

    var __galleryFolderManagerPanel = document.createElement('div');
    __galleryFolderManagerPanel.style.cssText = 'display: none;';
    __galleryFolderManagerPanel.appendChild(__createSectionTitle('Gallery Folder Manager設置'));
    __galleryFolderManagerPanel.appendChild(__createCheckboxRow(__cbGalleryFolderManagerCopyWithExtension, '是否複製副檔名'));

    var __dictPanel = document.createElement('div');
    __dictPanel.style.cssText = 'display: none;';
    __dictPanel.appendChild(__createSectionTitle('Dict Manager設置'));
    __dictPanel.appendChild(__createCheckboxRow(__cbAutoSwitchDictDropdown, 'Dict Manager點擊時頂部下拉清單是否自動切換'));
    __dictPanel.appendChild(__createFieldRow('優先度固定補零長度', __inputDictPriorityPadLength, 170));

    var __priorityPanel = document.createElement('div');
    __priorityPanel.style.cssText = 'display: none;';
    __priorityPanel.appendChild(__createSectionTitle('特殊標記優先度設置'));

    var __priorityLabel = document.createElement('div');
    __priorityLabel.textContent = '特殊標記優先度';
    __priorityLabel.style.cssText =
        'font-size: 9pt;' +
        'font-weight: bold;' +
        'color: ' + __panelFg + ';' +
        'margin-bottom: 10px;';
    __priorityPanel.appendChild(__priorityLabel);

    var __priorityNote = document.createElement('div');
    __priorityNote.textContent = '數字越小越優先，使用上下按鈕調整順序。';
    __priorityNote.style.cssText =
        'font-size: 8.5pt;' +
        'color: ' + __panelFg + ';' +
        'margin-bottom: 10px;';
    __priorityPanel.appendChild(__priorityNote);
    __priorityPanel.appendChild(__priorityTable);

    var __debugPanel = document.createElement('div');
    __debugPanel.style.cssText = 'display: none;';
    __debugPanel.appendChild(__createSectionTitle('偵錯設置'));
    __debugPanel.appendChild(__createCheckboxRow(__cbShowDebugLogs, '顯示debug訊息'));
    __debugPanel.appendChild(__createCheckboxRow(__cbLogToBrowserConsole, '在瀏覽器主控台中輸出控制台訊息'));

    var __initPanel = document.createElement('div');
    __initPanel.style.cssText = 'display: none;';
    __initPanel.appendChild(__createSectionTitle('初始化'));

    var __initNote = document.createElement('div');
    __initNote.textContent = '初始化操作會清除對應資料，請謹慎使用。';
    __initNote.style.cssText =
        'font-size: 9pt;' +
        'color: ' + __panelFg + ';' +
        'margin-bottom: 12px;';
    __initPanel.appendChild(__initNote);

    var __initBtnWrap = document.createElement('div');
    __initBtnWrap.style.cssText =
        'display: flex;' +
        'flex-wrap: wrap;' +
        'gap: 8px;';

    var __clearCacheBtn = document.createElement('button');
    __clearCacheBtn.textContent = '清理緩存';
    __styleButton(__clearCacheBtn, false);

    var __resetDictBtn = document.createElement('button');
    __resetDictBtn.textContent = '重置字典';
    __styleButton(__resetDictBtn, false);

    var __resetSettingsBtn = document.createElement('button');
    __resetSettingsBtn.textContent = '重置設置';
    __styleButton(__resetSettingsBtn, false);

    __initBtnWrap.appendChild(__clearCacheBtn);
    __initBtnWrap.appendChild(__resetDictBtn);
    __initBtnWrap.appendChild(__resetSettingsBtn);
    __initPanel.appendChild(__initBtnWrap);

    var __saveSettingsBtn = document.createElement('button');
    __saveSettingsBtn.textContent = '保存設置';
    __styleButton(__saveSettingsBtn, true);
    __contentFooter.appendChild(__saveSettingsBtn);

    __contentScroll.appendChild(__generalPanel);
    __contentScroll.appendChild(__interfacePanel);
    __contentScroll.appendChild(__galleryFolderManagerPanel);
    __contentScroll.appendChild(__dictPanel);
    __contentScroll.appendChild(__priorityPanel);
    __contentScroll.appendChild(__debugPanel);
    __contentScroll.appendChild(__initPanel);

    var __tabs = [
        { key: 'general', label: '通用設置', panel: __generalPanel },
        { key: 'interface', label: '介面設置', panel: __interfacePanel },
        { key: 'galleryFolderManager', label: 'Gallery Folder Manager設置', panel: __galleryFolderManagerPanel },
        { key: 'dict', label: 'Dict Manager設置', panel: __dictPanel },
        { key: 'priority', label: '特殊標記優先度設置', panel: __priorityPanel },
        { key: 'debug', label: '偵錯設置', panel: __debugPanel },
        { key: 'init', label: '初始化', panel: __initPanel }
    ];

    var __tabButtons = {};

    function __setActiveTab(tabKey) {
        __tabs.forEach(function(tab) {
            var active = tab.key === tabKey;
            tab.panel.style.display = active ? 'block' : 'none';
            if (__tabButtons[tab.key]) {
                __tabButtons[tab.key].style.background = active ? __activeBg : 'transparent';
                __tabButtons[tab.key].style.color = active ? __activeFg : __panelFg;
            }
        });
    }

    __tabs.forEach(function(tab) {
        var btn = __createTabButton(tab.label);
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            __setActiveTab(tab.key);
        });
        __sidebar.appendChild(btn);
        __tabButtons[tab.key] = btn;
    });

    __setActiveTab('general');

    __clearCacheBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var msg1 = '確認要清理緩存嗎？\n\n將刪除以下內容：\n• 已保存的圖庫資料\n• 文件列表\n• 評論模板\n• 掃描的文件夾\n• 本地文件夾授權\n• 所有待處理任務\n• 外部字典緩存\n\n將保留：\n• 腳本設置\n• 本地自定義字典';
        if (!confirm(msg1)) return;
        if (!confirm('二次確認：所有資料將永久刪除，無法復原。確定繼續？')) return;

        var gmKeys = [
            'saved_galleries', 'file_lists', 'comment_templates',
            'scanned_folders', 'local_folders',
            'pending_create', 'pending_create_queue', 'pending_upload',
            'create_success'
        ];
        gmKeys.forEach(function(key) {
            GM_deleteValue(key);
        });
        opLog('清理緩存', { type: 'GM + IndexedDB' });

        var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
        dbReq.onsuccess = function() {
            flowLog('ClearCache', 'IndexedDB 已刪除');
            var unpublishedSection = document.querySelector('.s[data-custom="true"]');
            if (unpublishedSection) unpublishedSection.remove();
            __clearCacheBtn.textContent = '已清空 ✓';
            setTimeout(function() {
                __clearCacheBtn.textContent = '清理緩存';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ClearCache', 'IndexedDB 刪除失敗', ev.target.error);
            __clearCacheBtn.textContent = '清空失敗';
            setTimeout(function() {
                __clearCacheBtn.textContent = '清理緩存';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ClearCache', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            __clearCacheBtn.textContent = '請關閉其他分頁';
            setTimeout(function() {
                __clearCacheBtn.textContent = '清理緩存';
            }, 3000);
        };
    });

    __resetDictBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var msg1 = '確認要重置字典嗎？\n\n將刪除以下內容：\n• 外部字典緩存\n\n下次使用羅馬字轉換時將自動重新下載。\n\n將保留：\n• 所有用戶數據\n• 腳本設置\n• 本地自定義字典';
        if (!confirm(msg1)) return;
        if (!confirm('二次確認：此操作無法復原。確定繼續？')) return;

        var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
        dbReq.onsuccess = function() {
            opLog('重置字典', { scope: 'IndexedDB' });
            __resetDictBtn.textContent = '已重置 ✓';
            setTimeout(function() {
                __resetDictBtn.textContent = '重置字典';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ResetDict', 'IndexedDB 刪除失敗', ev.target.error);
            __resetDictBtn.textContent = '重置失敗';
            setTimeout(function() {
                __resetDictBtn.textContent = '重置字典';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ResetDict', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            __resetDictBtn.textContent = '請關閉其他分頁';
            setTimeout(function() {
                __resetDictBtn.textContent = '重置字典';
            }, 3000);
        };
    });

    __resetSettingsBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var msg1 = '確認要重置設置嗎？\n\n將刪除本地設置並還原至默認值。\n\n將保留：\n• 已保存的圖庫資料\n• 本地自定義字典\n• 外部字典緩存';
        if (!confirm(msg1)) return;
        if (!confirm('二次確認：此操作無法復原。確定繼續？')) return;

        try {
            GM_deleteValue('fifybuj_settings');
            var defaultSettings = getDefaultSettings();
            GM_setValue('fifybuj_settings', defaultSettings);
            currentSettings = defaultSettings;
            opLog('重置設置', defaultSettings);
            __resetSettingsBtn.textContent = '已重置 ✓';
            setTimeout(function() {
                __resetSettingsBtn.textContent = '重置設置';
                window.location.reload();
            }, 2000);
        } catch (err) {
            errorLog('ResetSettings', '重置失敗', err);
            __resetSettingsBtn.textContent = '重置失敗';
            setTimeout(function() {
                __resetSettingsBtn.textContent = '重置設置';
            }, 2000);
        }
    });

    __saveSettingsBtn.addEventListener('click', function(e) {
        e.preventDefault();

        var newPriorities = {};
        __priorityList.forEach(function(item, index) {
            newPriorities[item.key] = index + 1;
        });

        var newRootFolder = __inputRootFolder.value.trim();
        var newSettings = Object.assign({}, getDefaultSettings(), getCurrentSettingsSafe(), {
            customRootFolder: newRootFolder,
            retryCount: parseInt(__inputRetryCount.value, 10) || 3,
            translatedDefaultMTL: __cbTranslatedDefaultMTL.checked,
            nonJapaneseDefaultTranslated: __cbNonJapaneseDefaultTranslated.checked,
            japaneseDefaultOfficialTextless: __cbJapaneseDefaultOfficialTextless.checked,
            autoSwitchDictDropdown: __cbAutoSwitchDictDropdown.checked,
            showDebugLogsInBrowserConsole: __cbShowDebugLogs.checked,
            dictPriorityPadLength: parseInt(__inputDictPriorityPadLength.value, 10) || 5,
            deleteDoubleConfirm: __cbDeleteDoubleConfirm.checked,
            doubleConfirmMs: parseInt(__inputDoubleConfirmMs.value, 10) || 1000,
            logToBrowserConsole: __cbLogToBrowserConsole.checked,
            confirmBtnColorChange: __cbConfirmBtnColor.checked,
            confirmBtnColorMs: parseInt(__inputConfirmColorMs.value, 10) || 1000,
            previewMaxWidth: parseInt(__inputPreviewMaxWidth.value, 10) || 800,
            previewMaxHeight: parseInt(__inputPreviewMaxHeight.value, 10) || 800,
            optionPriorities: newPriorities
        });

        saveSettings(newSettings);

        if (newRootFolder && window.showDirectoryPicker) {
            __rootFolderStatus.textContent = '等待授權...';
            window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' })
                .then(function(handle) {
                    return dbSet('handles', 'root_folder_handle', handle).then(function() {
                        return handle.queryPermission({ mode: 'read' });
                    }).then(function(perm) {
                        __rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '授權失敗';
                    });
                })
                .catch(function(err) {
                    __rootFolderStatus.textContent = err.name !== 'AbortError' ? '授權失敗' : '已取消';
                });
        } else {
            __refreshRootFolderPermissionStatus();
        }

        flashButtonSavedState(__saveSettingsBtn, '已保存 ✓', '保存設置', 1500);
    });

    return __container;


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
    var label1 = document.createElement('label');
    label1.textContent = '自定義根文件夾:';
    label1.style.cssText = 'font-size: 9pt; width: 120px; flex-shrink: 0;';

    var rootFolderStatus = document.createElement('span');
    rootFolderStatus.style.cssText = 'font-size: 8pt; color: #5C0D12; flex-shrink: 0; white-space: nowrap;';

    var input1 = document.createElement('input');
    input1.type = 'text';
    input1.value = settings.customRootFolder || '';
    input1.placeholder = '保存後自動要求授權';
    input1.style.cssText = 'flex: 1; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';

    function refreshRootFolderPermissionStatus() {
        dbGet('handles', 'root_folder_handle').then(function(handle) {
            if (!handle) {
                rootFolderStatus.textContent = '未授權';
                return;
            }
            return handle.queryPermission({ mode: 'read' }).then(function(perm) {
                rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '未授權';
            });
        }).catch(function() {
            rootFolderStatus.textContent = '未授權';
        });
    }

    input1.addEventListener('blur', function() {
        refreshRootFolderPermissionStatus();
    });

    refreshRootFolderPermissionStatus();

    row1.appendChild(label1);
    row1.appendChild(input1);
    row1.appendChild(rootFolderStatus);
    container.appendChild(row1);

    var row2 = document.createElement('div');
    row2.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
    var label2 = document.createElement('label');
    label2.textContent = '創建失敗重試次數 (1-10):';
    label2.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0;';
    var input2 = document.createElement('input');
    input2.type = 'number';
    input2.min = '1';
    input2.max = '10';
    input2.value = settings.retryCount || 3;
    input2.style.cssText = 'width: 60px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    input2.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) this.value = 1;
        if (v > 10) this.value = 10;
    });
    row2.appendChild(label2);
    row2.appendChild(input2);
    container.appendChild(row2);

    var row3 = document.createElement('div');
    row3.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
    var cb3 = document.createElement('input');
    cb3.type = 'checkbox';
    cb3.checked = settings.translatedDefaultMTL;
    cb3.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var label3 = document.createElement('label');
    label3.textContent = '勾選 Translated 時默認啟用 MTL';
    label3.style.cssText = 'font-size: 9pt;';
    row3.appendChild(cb3);
    row3.appendChild(label3);
    container.appendChild(row3);

    var row4 = document.createElement('div');
    row4.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
    var cb4 = document.createElement('input');
    cb4.type = 'checkbox';
    cb4.checked = settings.nonJapaneseDefaultTranslated;
    cb4.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var label4 = document.createElement('label');
    label4.textContent = '選擇除 Japanese 的語言時默認啟用 Translated';
    label4.style.cssText = 'font-size: 9pt;';
    row4.appendChild(cb4);
    row4.appendChild(label4);
    container.appendChild(row4);

    var row4c = document.createElement('label');
    row4c.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text; cursor: pointer;';
    var cb4c = document.createElement('input');
    cb4c.type = 'checkbox';
    cb4c.checked = !!settings.showDebugLogsInBrowserConsole;
    cb4c.style.cssText = 'accent-color: #5C0D12; flex: 0 0 auto; margin: 0;';
    var label4c = document.createElement('span');
    label4c.textContent = '顯示debug訊息';
    label4c.style.cssText = 'font-size: 9pt; flex: 0 1 auto; min-width: 0; white-space: nowrap; user-select: text;';
    row4c.appendChild(cb4c);
    row4c.appendChild(label4c);
    container.appendChild(row4c);

    var row4c = document.createElement('div');
    row4c.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
    var cb4c = document.createElement('input');
    cb4c.type = 'checkbox';
    cb4c.checked = !!settings.japaneseDefaultOfficialTextless;
    cb4c.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var label4c = document.createElement('label');
    label4c.textContent = '選擇 Japanese 時默認啟用 Official / Textless';
    label4c.style.cssText = 'font-size: 9pt;';
    row4c.appendChild(cb4c);
    row4c.appendChild(label4c);
    container.appendChild(row4c);

    var row4b = document.createElement('div');
    row4b.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px;';
    var cb4b = document.createElement('input');
    cb4b.type = 'checkbox';
    cb4b.checked = settings.autoSwitchDictDropdown !== false;
    cb4b.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var label4b = document.createElement('label');
    label4b.textContent = 'Dict Manager點擊時頂部下拉清單是否自動切換';
    label4b.style.cssText = 'font-size: 9pt;';
    row4b.appendChild(cb4b);
    row4b.appendChild(label4b);
    container.appendChild(row4b);

    var rowDictPriorityPad = document.createElement('div');
    rowDictPriorityPad.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var labelDictPriorityPad = document.createElement('label');
    labelDictPriorityPad.textContent = '優先度固定補零長度:';
    labelDictPriorityPad.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0; user-select: text;';
    var inputDictPriorityPad = document.createElement('input');
    inputDictPriorityPad.type = 'number';
    inputDictPriorityPad.min = '1';
    inputDictPriorityPad.max = '20';
    inputDictPriorityPad.value = settings.dictPriorityPadLength || 5;
    inputDictPriorityPad.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    inputDictPriorityPad.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) this.value = 1;
        if (v > 20) this.value = 20;
    });
    rowDictPriorityPad.appendChild(labelDictPriorityPad);
    rowDictPriorityPad.appendChild(inputDictPriorityPad);
    container.appendChild(rowDictPriorityPad);

    var rowLogConsole = document.createElement('div');
    rowLogConsole.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var cbLogConsole = document.createElement('input');
    cbLogConsole.type = 'checkbox';
    cbLogConsole.checked = settings.logToBrowserConsole || false;
    cbLogConsole.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var labelLogConsole = document.createElement('label');
    labelLogConsole.textContent = '在瀏覽器主控台中輸出控制台訊息';
    labelLogConsole.style.cssText = 'font-size: 9pt; user-select: text;';
    rowLogConsole.appendChild(cbLogConsole);
    rowLogConsole.appendChild(labelLogConsole);
    container.appendChild(rowLogConsole);

    var row5 = document.createElement('div');
    row5.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var cb5 = document.createElement('input');
    cb5.type = 'checkbox';
    cb5.checked = settings.deleteDoubleConfirm;
    cb5.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var label5 = document.createElement('label');
    label5.textContent = '刪除時需要雙重確認';
    label5.style.cssText = 'font-size: 9pt; user-select: text;';
    row5.appendChild(cb5);
    row5.appendChild(label5);
    container.appendChild(row5);

    var row6 = document.createElement('div');
    row6.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var label6 = document.createElement('label');
    label6.textContent = '雙重確認時間 (毫秒, 0-10000):';
    label6.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0; user-select: text;';
    var input6 = document.createElement('input');
    input6.type = 'number';
    input6.min = '0';
    input6.max = '10000';
    input6.value = settings.doubleConfirmMs || 1000;
    input6.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    input6.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) this.value = 0;
        if (v > 10000) this.value = 10000;
    });
    row6.appendChild(label6);
    row6.appendChild(input6);
    container.appendChild(row6);

    var rowConfirmColor = document.createElement('div');
    rowConfirmColor.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var cbConfirmColor = document.createElement('input');
    cbConfirmColor.type = 'checkbox';
    cbConfirmColor.checked = settings.confirmBtnColorChange !== false;
    cbConfirmColor.style.cssText = 'margin: 0; accent-color: #5C0D12;';
    var labelConfirmColor = document.createElement('label');
    labelConfirmColor.textContent = '讀取確認按鈕是否變色';
    labelConfirmColor.style.cssText = 'font-size: 9pt; user-select: text;';
    rowConfirmColor.appendChild(cbConfirmColor);
    rowConfirmColor.appendChild(labelConfirmColor);
    container.appendChild(rowConfirmColor);

    var rowConfirmColorMs = document.createElement('div');
    rowConfirmColorMs.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var labelConfirmColorMs = document.createElement('label');
    labelConfirmColorMs.textContent = '確認按鈕變色時長 (毫秒):';
    labelConfirmColorMs.style.cssText = 'font-size: 9pt; width: 180px; flex-shrink: 0; user-select: text;';
    var inputConfirmColorMs = document.createElement('input');
    inputConfirmColorMs.type = 'number';
    inputConfirmColorMs.min = '0';
    inputConfirmColorMs.max = '10000';
    inputConfirmColorMs.value = settings.confirmBtnColorMs || 1000;
    inputConfirmColorMs.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    inputConfirmColorMs.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) this.value = 0;
        if (v > 10000) this.value = 10000;
    });
    rowConfirmColorMs.appendChild(labelConfirmColorMs);
    rowConfirmColorMs.appendChild(inputConfirmColorMs);
    container.appendChild(rowConfirmColorMs);

    var rowPreviewSize = document.createElement('div');
    rowPreviewSize.style.cssText = 'margin-bottom: 8px; display: flex; align-items: center; gap: 8px; user-select: text;';
    var labelPreviewW = document.createElement('label');
    labelPreviewW.textContent = '預覧圖片最大寬度 (px):';
    labelPreviewW.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; user-select: text;';
    var inputPreviewW = document.createElement('input');
    inputPreviewW.type = 'number';
    inputPreviewW.min = '1';
    inputPreviewW.max = '9999';
    inputPreviewW.value = settings.previewMaxWidth || 800;
    inputPreviewW.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    inputPreviewW.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) this.value = 1;
        if (v > 9999) this.value = 9999;
    });
    var labelPreviewH = document.createElement('label');
    labelPreviewH.textContent = '最大高度 (px):';
    labelPreviewH.style.cssText = 'font-size: 9pt; white-space: nowrap; flex-shrink: 0; user-select: text; margin-left: 16px;';
    var inputPreviewH = document.createElement('input');
    inputPreviewH.type = 'number';
    inputPreviewH.min = '1';
    inputPreviewH.max = '9999';
    inputPreviewH.value = settings.previewMaxHeight || 800;
    inputPreviewH.style.cssText = 'width: 80px; border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px; height: 20px;';
    inputPreviewH.addEventListener('input', function() {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) this.value = 1;
        if (v > 9999) this.value = 9999;
    });
    rowPreviewSize.appendChild(labelPreviewW);
    rowPreviewSize.appendChild(inputPreviewW);
    rowPreviewSize.appendChild(labelPreviewH);
    rowPreviewSize.appendChild(inputPreviewH);
    container.appendChild(rowPreviewSize);

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
        return {
            key: item.key,
            label: item.label,
            tagMain: item.tagMain,
            tagJp: item.tagJp,
            priority: currentPriorities[item.key] || 99
        };
    });
    priorityList.sort(function(a, b) { return a.priority - b.priority; });

    var previewDiv = document.createElement('div');
    previewDiv.style.cssText = 'font-size: 9pt; color: #333; padding: 4px 0; margin-bottom: 6px; word-break: break-all; line-height: 1.8;';

    function updatePreview() {
        var mainLine = '[Anthology] Title [Chinese]';
        var jpLine = '[アンソロジー] タイトル [中国翻訳]';
        priorityList.forEach(function(item) {
            mainLine += ' ' + item.tagMain;
            if (item.tagJp) jpLine += ' ' + item.tagJp;
        });
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
            var labelEl = document.createElement('span');
            labelEl.textContent = item.label;
            labelEl.style.cssText = 'font-size: 9pt; flex: 1; min-width: 160px;';

            var upBtn = document.createElement('button');
            upBtn.textContent = '↑';
            applyPageToneBtnStyle(upBtn, 'width: 22px;height: 20px;padding: 0;line-height: 18px;');
            if (index === 0) {
                upBtn.style.opacity = '0.3';
                upBtn.style.cursor = 'default';
            }
            upBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === 0) return;
                var tmp = priorityList[index];
                priorityList[index] = priorityList[index - 1];
                priorityList[index - 1] = tmp;
                rebuildPriorityList();
                updatePreview();
            });

            var downBtn = document.createElement('button');
            downBtn.textContent = '↓';
            applyPageToneBtnStyle(downBtn, 'width: 22px;height: 20px;padding: 0;line-height: 18px;');
            if (index === priorityList.length - 1) {
                downBtn.style.opacity = '0.3';
                downBtn.style.cursor = 'default';
            }
            downBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (index === priorityList.length - 1) return;
                var tmp2 = priorityList[index];
                priorityList[index] = priorityList[index + 1];
                priorityList[index + 1] = tmp2;
                rebuildPriorityList();
                updatePreview();
            });

            row.appendChild(labelEl);
            row.appendChild(upBtn);
            row.appendChild(downBtn);
            priorityTable.appendChild(row);
        });
    }
    rebuildPriorityList();
    container.appendChild(priorityTable);

    var saveRow = document.createElement('div');
    saveRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 10px;';

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
            'pending_create', 'pending_create_queue', 'pending_upload',
            'create_success'
        ];
        gmKeys.forEach(function(key) {
            GM_deleteValue(key);
        });
        opLog('清理緩存', { type: 'GM + IndexedDB' });

        var dbReq = indexedDB.deleteDatabase('FIFYBUJ_DB');
        dbReq.onsuccess = function() {
            flowLog('ClearCache', 'IndexedDB 已刪除');
            var unpublishedSection = document.querySelector('.s[data-custom="true"]');
            if (unpublishedSection) unpublishedSection.remove();
            clearCacheBtn.textContent = '已清空 ✓';
            clearCacheBtn.style.backgroundColor = '#007700';
            setTimeout(function() {
                clearCacheBtn.textContent = '清理緩存';
                clearCacheBtn.style.backgroundColor = '#8B0000';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ClearCache', 'IndexedDB 刪除失敗', ev.target.error);
            clearCacheBtn.textContent = '清空失敗';
            clearCacheBtn.style.backgroundColor = '#CC0000';
            setTimeout(function() {
                clearCacheBtn.textContent = '清理緩存';
                clearCacheBtn.style.backgroundColor = '#8B0000';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ClearCache', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            clearCacheBtn.textContent = '請關閉其他分頁';
            clearCacheBtn.style.backgroundColor = '#CC6600';
            setTimeout(function() {
                clearCacheBtn.textContent = '清理緩存';
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
            opLog('重置字典', { scope: 'IndexedDB' });
            resetDictBtn.textContent = '已重置 ✓';
            resetDictBtn.style.backgroundColor = '#007700';
            setTimeout(function() {
                resetDictBtn.textContent = '重置字典';
                resetDictBtn.style.backgroundColor = '#8B4500';
            }, 2000);
        };
        dbReq.onerror = function(ev) {
            errorLog('ResetDict', 'IndexedDB 刪除失敗', ev.target.error);
            resetDictBtn.textContent = '重置失敗';
            resetDictBtn.style.backgroundColor = '#CC0000';
            setTimeout(function() {
                resetDictBtn.textContent = '重置字典';
                resetDictBtn.style.backgroundColor = '#8B4500';
            }, 2000);
        };
        dbReq.onblocked = function() {
            warnLog('ResetDict', 'IndexedDB 刪除被阻擋，請關閉其他分頁後重試');
            resetDictBtn.textContent = '請關閉其他分頁';
            resetDictBtn.style.backgroundColor = '#CC6600';
            setTimeout(function() {
                resetDictBtn.textContent = '重置字典';
                resetDictBtn.style.backgroundColor = '#8B4500';
            }, 3000);
        };
    });

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
            currentSettings = defaultSettings;
            opLog('重置設置', defaultSettings);
            resetSettingsBtn.textContent = '已重置 ✓';
            resetSettingsBtn.style.backgroundColor = '#007700';
            setTimeout(function() {
                resetSettingsBtn.textContent = '重置設置';
                resetSettingsBtn.style.backgroundColor = '#5C6B00';
                window.location.reload();
            }, 2000);
        } catch (err) {
            errorLog('ResetSettings', '重置失敗', err);
            resetSettingsBtn.textContent = '重置失敗';
            resetSettingsBtn.style.backgroundColor = '#CC0000';
            setTimeout(function() {
                resetSettingsBtn.textContent = '重置設置';
                resetSettingsBtn.style.backgroundColor = '#5C6B00';
            }, 2000);
        }
    });

    var saveSettingsBtn = document.createElement('button');
    saveSettingsBtn.textContent = '保存設置';
    applyPrimaryDarkBtnStyle(saveSettingsBtn, 'padding: 4px 16px;border: none;');
    saveSettingsBtn.addEventListener('mouseenter', function() { this.style.backgroundColor = '#7A1E24'; });
    saveSettingsBtn.addEventListener('mouseleave', function() { this.style.backgroundColor = '#5C0D12'; });
    saveSettingsBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var newRootFolder = input1.value.trim();
        var newPriorities = {};
        priorityList.forEach(function(item, index) {
            newPriorities[item.key] = index + 1;
        });

        var newSettings = {
            customRootFolder: newRootFolder,
            retryCount: parseInt(input2.value, 10) || 3,
            translatedDefaultMTL: cb3.checked,
            nonJapaneseDefaultTranslated: cb4.checked,
            japaneseDefaultOfficialTextless: cb4c.checked,
            autoSwitchDictDropdown: cb4b.checked,
            showDebugLogsInBrowserConsole: cb4c.checked,
            dictPriorityPadLength: parseInt(inputDictPriorityPad.value, 10) || 5,
            deleteDoubleConfirm: cb5.checked,
            doubleConfirmMs: parseInt(input6.value, 10) || 1000,
            logToBrowserConsole: cbLogConsole.checked,
            confirmBtnColorChange: cbConfirmColor.checked,
            confirmBtnColorMs: parseInt(inputConfirmColorMs.value, 10) || 1000,
            previewMaxWidth: parseInt(inputPreviewW.value, 10) || 800,
            previewMaxHeight: parseInt(inputPreviewH.value, 10) || 800,
            optionPriorities: newPriorities
        };

        saveSettings(newSettings);

        if (newRootFolder && window.showDirectoryPicker) {
            rootFolderStatus.textContent = '等待授權...';
            window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' })
                .then(function(handle) {
                    return dbSet('handles', 'root_folder_handle', handle).then(function() {
                        return handle.queryPermission({ mode: 'read' });
                    }).then(function(perm) {
                        rootFolderStatus.textContent = perm === 'granted' ? '✓ 已授權' : '授權失敗';
                    });
                })
                .catch(function(err) {
                    rootFolderStatus.textContent = err.name !== 'AbortError' ? '授權失敗' : '已取消';
                });
        }

        flashButtonSavedState(saveSettingsBtn, '已保存 ✓', '保存設置', 1500);
    });

    saveRow.appendChild(clearCacheBtn);
    saveRow.appendChild(resetDictBtn);
    saveRow.appendChild(resetSettingsBtn);
    saveRow.appendChild(saveSettingsBtn);
    container.appendChild(saveRow);

    return container;
}

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
    catGoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
            var fields = getGalleryGroupFields(group);
            if (!fields || !fields.categorySelect) return;
            setGalleryGroupSelectValue(fields.categorySelect, toolCatSelect.value);
        });
    });
    toolRowDiv.appendChild(catGoBtn);

    var allLangLabel = document.createElement('span'); allLangLabel.textContent = 'All Language:'; allLangLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
    toolRowDiv.appendChild(allLangLabel);
    var toolLangSelect = createLangSelect(); toolLangSelect.style.verticalAlign = 'middle'; toolRowDiv.appendChild(toolLangSelect);
    var langGoBtn = createGoBtn(); langGoBtn.style.marginRight = '8px';
    langGoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
            var fields = getGalleryGroupFields(group);
            if (!fields || !fields.languageSelect) return;
            setGalleryGroupSelectValue(fields.languageSelect, toolLangSelect.value);
        });
    });
    toolRowDiv.appendChild(langGoBtn);

    var allFolderLabel = document.createElement('span'); allFolderLabel.textContent = 'All Folder:'; allFolderLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
    toolRowDiv.appendChild(allFolderLabel);
    var toolFolderSelect = createFolderSelect(); toolFolderSelect.style.verticalAlign = 'middle'; toolRowDiv.appendChild(toolFolderSelect);
    var folderGoBtn = createGoBtn(); folderGoBtn.style.marginRight = '8px';
    folderGoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
            var fields = getGalleryGroupFields(group);
            if (!fields || !fields.folderSelect) return;
            setGalleryGroupSelectValue(fields.folderSelect, toolFolderSelect.value);
        });
    });
    toolRowDiv.appendChild(folderGoBtn);

    var allLabel = document.createElement('span'); allLabel.textContent = 'All:'; allLabel.style.cssText = 'font-size: 9pt; vertical-align: middle;';
    toolRowDiv.appendChild(allLabel);
    var actionSelect = document.createElement('select');
    applySelectStyle(actionSelect, '112px'); actionSelect.style.verticalAlign = 'middle';
    actionSelect.__fifybujAllActionSelect = true;
    actionSelect.setAttribute('data-fifybuj-all-action-select', '1');
    ['Save', 'Create', 'Delete', 'Romanization'].forEach(function(val) {
        var option = document.createElement('option');
        option.value = val;
        option.textContent = val;
        actionSelect.appendChild(option);
    });
    toolRowDiv.appendChild(actionSelect);

    var actionGoBtn = createGoBtn();
    actionGoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var action = actionSelect.value;
        if (action === 'Save') {
            var savedCount = allSaveChecked(tbody, folderRow1);
            if (savedCount > 0) flashButtonSavedState(actionGoBtn, '✓', 'GO', 1000);
            else flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
        } else if (action === 'Create') {
            var createdCount = allCreateChecked(tbody);
            if (createdCount > 0) flashButtonSavedState(actionGoBtn, '✓', 'GO', 1000);
            else flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
        } else if (action === 'Delete') {
            triggerDeleteBySettings(actionGoBtn, function() {
                var deletedCount = allDeleteChecked(tbody, folderRow1, waitingCreateCountRef);
                if (deletedCount > 0) flashButtonSavedState(actionGoBtn, '✓', 'GO', 1000);
                else flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
            });
        } else if (action === 'Romanization') {
            allRomanizationChecked(tbody).then(function(count) {
                if (count > 0) flashButtonSavedState(actionGoBtn, '✓', 'GO', 1000);
                else flashButtonErrorState(actionGoBtn, 'Fail', 'GO', 1000);
            });
        }
    });
    toolRowDiv.appendChild(actionGoBtn);
    sectionDiv.appendChild(toolRowDiv);

    var optionsRowDiv = document.createElement('div');
    optionsRowDiv.style.cssText = 'padding: 3px 4px; background-color: #E0DED3; border-top: 1px solid #5C0D12; display: flex; align-items: center; white-space: nowrap; gap: 4px;';

    var optionsLeft = document.createElement('div');
    optionsLeft.style.cssText = 'display: grid !important; grid-template-areas: "cg as cl sp off tra rew dig dec ai" "cg as cl sp col tex inc sam ong ant" !important; grid-template-columns: max-content max-content max-content 1fr max-content max-content max-content max-content max-content max-content !important; grid-template-rows: auto auto !important; column-gap: 8px !important; row-gap: 2px !important; align-items: center !important; width: 100% !important;';

    var createGalleryBtn2 = document.createElement('button');
    createGalleryBtn2.innerHTML = 'Create<br>Gallery';
    createGalleryBtn2.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; padding: 0 4px; cursor: pointer; border-radius: 3px; white-space: normal; box-sizing: border-box; text-align: center; grid-area: cg; align-self: stretch; word-break: keep-all; line-height: 1.4; width: 100%;';
    createGalleryBtn2.addEventListener('click', function(e) {
        e.preventDefault();
        var folderToggle1 = folderRow1.querySelector('.folder-toggle');
        if (folderToggle1 && folderToggle1.textContent === '[+]') {
            var nextRow = folderRow1.nextElementSibling;
            while (nextRow) {
                if (!nextRow.classList.contains('gtr')) nextRow.style.display = 'table-row';
                nextRow = nextRow.nextElementSibling;
            }
            folderToggle1.textContent = '[-]';
            var spans = folderRight1.querySelectorAll('span');
            spans.forEach(function(span) { span.style.display = ''; });
        }
        var newGroup = createGalleryGroup(waitingCreateCountRef.value, null, tbody, folderRow1, sectionDiv, waitingCreateCountRef);
        tbody.appendChild(newGroup);
        waitingCreateCountRef.value++;
        var folderStrong1 = folderRow1.querySelector('strong');
        if (folderStrong1) folderStrong1.textContent = waitingCreateCountRef.value;
        requestAnimationFrame(function() { fixAllGroups(sectionDiv, folderRow1); });
        opLog('新增空白圖庫列', { count: waitingCreateCountRef.value });
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

    cbOpt_officialCb.addEventListener('click', function() {
        if (!cbOpt_translatedCb.checked && !cbOpt_rewriteCb.checked) { this.checked = true; return; }
        cbOpt_translatedCb.checked = false; cbOpt_rewriteCb.checked = false; cbOpt_mtlInner.style.visibility = 'hidden'; cbOpt_mtlCb.checked = false;
    });
    cbOpt_translatedCb.addEventListener('click', function() {
        if (!cbOpt_officialCb.checked && !cbOpt_rewriteCb.checked) { this.checked = true; return; }
        cbOpt_officialCb.checked = false; cbOpt_rewriteCb.checked = false; cbOpt_mtlInner.style.visibility = 'visible'; cbOpt_mtlCb.checked = true;
    });
    cbOpt_rewriteCb.addEventListener('click', function() {
        if (!cbOpt_officialCb.checked && !cbOpt_translatedCb.checked) { this.checked = true; return; }
        cbOpt_officialCb.checked = false; cbOpt_translatedCb.checked = false; cbOpt_mtlInner.style.visibility = 'hidden'; cbOpt_mtlCb.checked = false;
    });

    var allSaveBtn = document.createElement('button');
    allSaveBtn.innerHTML = 'All<br>Save';
    allSaveBtn.style.cssText = 'background-color: #E0DED3; border: 1px solid #5C0D12; color: #5C0D12; font-weight: bold; font-size: 8pt; padding: 0 4px; cursor: pointer; border-radius: 3px; white-space: normal; box-sizing: border-box; text-align: center; grid-area: as; align-self: stretch; word-break: keep-all; line-height: 1.4;';
    allSaveBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var savedCount = allSaveChecked(tbody, folderRow1);
        if (savedCount > 0) flashButtonSavedState(allSaveBtn, '✓', 'All Save', 1000);
        else flashButtonErrorState(allSaveBtn, 'Fail', 'All Save', 1000);
    });

    optionsLeft.appendChild(createGalleryBtn2);
    optionsLeft.appendChild(allSaveBtn);
    optionsLeft.appendChild(cleanBtn);
    optionsLeft.appendChild(spacer);
    optionsLeft.appendChild(cbOpt_official);
    optionsLeft.appendChild(cbOpt_translatedWrap);
    optionsLeft.appendChild(cbOpt_rewrite);
    optionsLeft.appendChild(cbOpt_digital);
    optionsLeft.appendChild(cbOpt_decensored);
    optionsLeft.appendChild(cbOpt_aiGenerated);
    optionsLeft.appendChild(cbOpt_colorized);
    optionsLeft.appendChild(cbOpt_textless);
    optionsLeft.appendChild(cbOpt_incomplete);
    optionsLeft.appendChild(cbOpt_sample);
    optionsLeft.appendChild(cbOpt_ongoing);
    optionsLeft.appendChild(cbOpt_anthology);

    var optionsGoBtn = createGoBtn();
    optionsGoBtn.style.marginLeft = '8px';
    optionsGoBtn.style.flexShrink = '0';
    optionsGoBtn.style.alignSelf = 'center';
    optionsGoBtn.addEventListener('click', function(e) {
        e.preventDefault();

        var optionState = {
            official: cbOpt_officialCb.checked,
            translated: cbOpt_translatedCb.checked,
            mtl: cbOpt_mtlCb.checked,
            rewrite: cbOpt_rewriteCb.checked,
            digital: cbOpt_digitalCb.checked,
            sample: cbOpt_sampleCb.checked,
            decensored: cbOpt_decensoredCb.checked,
            aiGenerated: cbOpt_aiGeneratedCb.checked,
            colorized: cbOpt_colorizedCb.checked,
            incomplete: cbOpt_incompleteCb.checked,
            ongoing: cbOpt_ongoingCb.checked,
            anthology: cbOpt_anthologyCb.checked
        };

        var appliedCount = 0;
        getCheckedGalleryGroupsFromTbody(tbody).forEach(function(group) {
            var fields = getGalleryGroupFields(group);
            if (!fields) return;
            applyGalleryOptionStateToFields(fields, optionState);
            appliedCount++;
        });

        if (appliedCount > 0) flashButtonSavedState(optionsGoBtn, '✓', 'GO', 1000);
        else flashButtonErrorState(optionsGoBtn, 'Fail', 'GO', 1000);
    });

    cleanBtn.addEventListener('click', function(e) {
        e.preventDefault();
        cbOpt_officialCb.checked = true;
        cbOpt_translatedCb.checked = false;
        cbOpt_rewriteCb.checked = false;
        cbOpt_mtlInner.style.visibility = 'hidden';
        cbOpt_mtlCb.checked = false;
        cbOpt_digitalCb.checked = false;
        cbOpt_decensoredCb.checked = false;
        cbOpt_aiGeneratedCb.checked = false;
        cbOpt_colorizedCb.checked = false;
        cbOpt_textlessCb.checked = false;
        cbOpt_incompleteCb.checked = false;
        cbOpt_sampleCb.checked = false;
        cbOpt_ongoingCb.checked = false;
        cbOpt_anthologyCb.checked = false;
    });

    optionsRowDiv.appendChild(optionsLeft);
    optionsRowDiv.appendChild(optionsGoBtn);
    sectionDiv.appendChild(optionsRowDiv);

    var buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'padding: 5px 2px; background-color: #E0DED3; border-bottom: 1px solid #5C0D12; border-top: 1px solid #5C0D12; display: flex; align-items: center;';

    var analyzeBtn = document.createElement('a'); analyzeBtn.href = '#'; analyzeBtn.innerHTML = '[Analyze Mode]'; analyzeBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 5px; cursor: pointer; background-color: #E0DED3;';
    var settingBtn = document.createElement('a'); settingBtn.href = '#'; settingBtn.innerHTML = '[Setting]'; settingBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
    var commentTemplateBtn = document.createElement('a'); commentTemplateBtn.href = '#'; commentTemplateBtn.innerHTML = '[Comment Template]'; commentTemplateBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
    var dictManagerBtn = document.createElement('a'); dictManagerBtn.href = '#'; dictManagerBtn.innerHTML = '[Dict Manager]'; dictManagerBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
    var showFileListBtn = document.createElement('a'); showFileListBtn.href = '#'; showFileListBtn.innerHTML = '[Gallery Folder Manager]'; showFileListBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';
    var consoleBtn = document.createElement('a'); consoleBtn.href = '#'; consoleBtn.innerHTML = '[Console]'; consoleBtn.style.cssText = 'font-weight: bold; color: #5C0D12; margin-left: 15px; cursor: pointer; background-color: #E0DED3;';

    buttonRow.appendChild(analyzeBtn);
    buttonRow.appendChild(showFileListBtn);
    buttonRow.appendChild(commentTemplateBtn);
    buttonRow.appendChild(dictManagerBtn);
    buttonRow.appendChild(settingBtn);
    buttonRow.appendChild(consoleBtn);
    sectionDiv.appendChild(buttonRow);

    var inputContainer = document.createElement('div');
    inputContainer.className = 'analyze-input-container';
    inputContainer.style.cssText = 'display: none; padding: 10px; background-color: #E0DED3; border: 1px solid #5C0D12; position: relative;';

    var analyzeTitle = document.createElement('div');
    analyzeTitle.textContent = 'Analyze Mode';
    analyzeTitle.style.cssText = 'font-weight: bold; font-size: 10pt; color: #5C0D12; margin-bottom: 10px; border-bottom: 1px solid #5C0D12; padding-bottom: 4px;';
    inputContainer.appendChild(analyzeTitle);

    var analyzeDropZone = document.createElement('div');
    analyzeDropZone.style.cssText = 'display: flex; gap: 8px; margin-bottom: 10px;';
    var archiveZone = document.createElement('div');
    archiveZone.style.cssText = 'flex: 1; border: 2px solid #5C0D12; border-radius: 6px; padding: 30px 20px; text-align: center; cursor: pointer; background-color: #EDE9DF;';
    archiveZone.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">📦</div><div style="font-size: 9pt; color: #5C0D12;">點擊選擇壓縮檔<br>ZIP</div>';
    var folderZone = document.createElement('div');
    folderZone.style.cssText = 'flex: 1; border: 2px solid #5C0D12; border-radius: 6px; padding: 30px 20px; text-align: center; cursor: pointer; background-color: #EDE9DF;';
    folderZone.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">📁</div><div style="font-size: 9pt; color: #5C0D12;">點擊選擇<br>文件夾</div>';
    analyzeDropZone.appendChild(archiveZone);
    analyzeDropZone.appendChild(folderZone);

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
            var indent2 = depth * 16;
            html += '<div style="padding: 1px 4px 1px ' + (indent2 + 4) + 'px; font-size: 8pt; color: #666;">📄 ' + f + '</div>';
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
        analyzeStatusBtn.textContent = '';
        analyzeStatusBtn.style.color = '#5C0D12';

        selectAuthorizedDirectoryWithPicker().then(function(selection) {
            var dirHandle = selection.handle;
            var authorizedRootEntry = selection.authorizedRootEntry;
            var relativeRootPath = buildAuthorizedRelativePathFromParts(selection.relativePathParts);
            var imageFiles = [];
            var skipped = 0;

            function scanDir(handle, prefix) {
                _debug('[Progress] 文件夾:', prefix || '/');
                var entries = handle.values();
                function processEntries() {
                    return entries.next().then(function(result) {
                        if (result.done) return;
                        var entry = result.value;
                        var fullPath = prefix ? prefix + '/' + entry.name : entry.name;
                        if (entry.kind === 'file') {
                            _debug('[Progress] 文件:', fullPath);
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
                var folderSourceLabel = relativeRootPath || dirHandle.name;
                var storedFiles = createGallerySourcePrefixedFileEntries(imageFiles, relativeRootPath);
                var entry = {
                    title: dirHandle.name,
                    folderName: relativeRootPath || '',
                    sourceLabel: folderSourceLabel,
                    authorizedRootId: authorizedRootEntry ? authorizedRootEntry.id : null,
                    files: storedFiles,
                    skipped: skipped
                };
                analyzeEntries.push(entry);
                analyzeStatusBtn.textContent = '讀取完成';
                setTimeout(function() {
                    analyzeStatusBtn.textContent = '';
                    analyzeStatusBtn.style.color = '#5C0D12';
                }, 2000);
                renderAnalyzeResults();
            });
        }).catch(function(err) {
            if (err && err.name === 'AbortError') {
                analyzeStatusBtn.textContent = '';
                analyzeStatusBtn.style.color = '#5C0D12';
                return;
            }

            errorLog('AnalyzeFolder', '錯誤', err);
            analyzeStatusBtn.textContent = '導入失敗：不在已授權文件夾內';
            analyzeStatusBtn.style.color = '#CC0000';
            setTimeout(function() {
                analyzeStatusBtn.textContent = '';
                analyzeStatusBtn.style.color = '#5C0D12';
            }, 2500);
        });
    }

    function handleAnalyzeArchiveSelection() {
        analyzeStatusBtn.textContent = '';
        analyzeStatusBtn.style.color = '#5C0D12';

        selectAuthorizedArchiveFilesWithPicker().then(function(selection) {
            handleAnalyzeFiles(selection.files || []);
        }).catch(function(err) {
            if (err && err.name === 'AbortError') {
                analyzeStatusBtn.textContent = '';
                analyzeStatusBtn.style.color = '#5C0D12';
                return;
            }

            var displayMessage = getAuthorizedSelectionFailureDisplayMessage(err, '壓縮檔');
            warnLog('Analyze', displayMessage, {
                code: err && err.code,
                message: err && (err.message || err)
            });
            analyzeStatusBtn.textContent = displayMessage;
            analyzeStatusBtn.style.color = '#CC0000';
            setTimeout(function() {
                analyzeStatusBtn.textContent = '';
                analyzeStatusBtn.style.color = '#5C0D12';
            }, 2500);
        });
    }

    archiveZone.addEventListener('click', function(e) {
        e.preventDefault();
        handleAnalyzeArchiveSelection();
    });

    folderZone.addEventListener('click', function(e) {
        e.preventDefault();
        handleAnalyzeFolder();
    });

    analyzeCreateAllBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (analyzeEntries.length === 0) return;
        var existingGalleries = getSavedGalleriesSafe();
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
                if (entry.authorizedRootId != null) {
                    var folderSourceLabel = entry.sourceLabel || entry.folderName || entry.title;
                    writeGalleryFileListById(
                        galleryData.id,
                        entry.folderName || '',
                        normalizeGalleryFileListEntries(entry.files),
                        'folder',
                        folderSourceLabel,
                        [{ name: folderSourceLabel, type: 'folder' }],
                        entry.authorizedRootId
                    );
                } else {
                    var archiveRootName = getArchiveSourceLabelFromResult(entry);
                    writeGalleryFileListById(
                        galleryData.id,
                        null,
                        createGallerySourcePrefixedFileEntries(entry.files, archiveRootName),
                        'archive',
                        archiveRootName,
                        [{ name: archiveRootName, type: 'archive' }],
                        null
                    );
                }
            }
        });
        saveSavedGalleriesSafe(existingGalleries);
        opLog('Analyze 建立圖庫', { count: analyzeEntries.length });

        analyzeCreateAllBtn.textContent = '已建立 ✓';
        setTimeout(function() { analyzeCreateAllBtn.textContent = '全部建立圖庫'; }, 1500);
        refreshShowFileListPanelIfOpen();

        var customSection = document.querySelector('.s[data-custom="true"]');
        if (customSection) {
            var tbodyLocal = customSection.querySelector('tbody');
            var folderRowLocal = customSection.querySelector('tr.gtr');
            var folderRightLocal = folderRowLocal ? folderRowLocal.querySelector('td.r') : null;
            if (tbodyLocal && folderRowLocal && folderRightLocal) {
                var waitingRef = { value: parseInt((folderRowLocal.querySelector('strong') || {}).textContent || '0', 10) };
                analyzeEntries.forEach(function(entry, idx) {
                    var savedData = existingGalleries[existingGalleries.length - analyzeEntries.length + idx];
                    var newGroup = createGalleryGroup(waitingRef.value, savedData, tbodyLocal, folderRowLocal, customSection, waitingRef);
                    tbodyLocal.appendChild(newGroup);
                    waitingRef.value++;
                });
                var folderStrong = folderRowLocal.querySelector('strong');
                if (folderStrong) folderStrong.textContent = waitingRef.value;
                requestAnimationFrame(function() { fixAllGroups(customSection, folderRowLocal); });
            }
        }

        analyzeEntries = [];
        renderAnalyzeResults();
    });

    inputContainer.appendChild(analyzeDropZone);
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
        if (!isVisible) {
            targetPanel.style.display = 'block';
            targetPanel.dispatchEvent(new Event('show'));
        }
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
        while (nextRow) {
            if (!nextRow.classList.contains('gtr')) {
                nextRow.style.display = isExpanded ? 'none' : 'table-row';
            }
            nextRow = nextRow.nextElementSibling;
        }
        this.textContent = isExpanded ? '[+]' : '[-]';
        var spans = folderRight1.querySelectorAll('span');
        spans.forEach(function(span) { span.style.display = isExpanded ? 'none' : ''; });
    });

    sectionDiv.addEventListener('click', function(e) {
        var target = e.target;
        if (target.classList.contains('select-all')) {
            e.preventDefault();
            var folderRow = target.closest('tr.gtr');
            var nextRow = folderRow.nextElementSibling;
            while (nextRow && !nextRow.classList.contains('gtr')) {
                var firstRowCheckbox = nextRow.querySelector('td.gtc6 input[type="checkbox"]');
                if (firstRowCheckbox) firstRowCheckbox.checked = true;
                nextRow = nextRow.nextElementSibling;
            }
        } else if (target.classList.contains('deselect-all')) {
            e.preventDefault();
            var folderRow2 = target.closest('tr.gtr');
            var nextRow2 = folderRow2.nextElementSibling;
            while (nextRow2 && !nextRow2.classList.contains('gtr')) {
                var firstRowCheckbox2 = nextRow2.querySelector('td.gtc6 input[type="checkbox"]');
                if (firstRowCheckbox2) firstRowCheckbox2.checked = false;
                nextRow2 = nextRow2.nextElementSibling;
            }
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
        e.preventDefault();
        sectionDiv.remove();
        if (!document.querySelector('.s[data-custom="true"]')) {
            var btn = document.getElementById('auto-create-upload-btn');
            if (btn) btn.style.fontWeight = 'normal';
        }
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
    var createNewDiv = Array.from(lbContainer.querySelectorAll('div')).find(function(div) {
        var link = div.querySelector('a');
        return link && link.textContent.includes('Create New Gallery');
    });
    if (!createNewDiv) return;

    var newDiv = document.createElement('div');
    newDiv.style.cssText = 'display: inline-block; margin-left: 0.5em;';
    var newLink = document.createElement('a');
    newLink.id = 'scan-folder-btn';
    newLink.href = '#';
    newLink.innerHTML = '[Scan Folder List]';
    newLink.style.fontWeight = 'normal';
    newDiv.appendChild(newLink);
    newDiv.appendChild(document.createTextNode(' '));

    var localLink = document.createElement('a');
    localLink.id = 'local-folder-btn';
    localLink.href = '#';
    localLink.innerHTML = '[Local Folder]';
    localLink.style.fontWeight = 'normal';
    newDiv.appendChild(localLink);

    createNewDiv.insertAdjacentElement('afterend', newDiv);
    newLink.addEventListener('click', function(e) { e.preventDefault(); scanFolders(); });
    localLink.addEventListener('click', function(e) { e.preventDefault(); showLocalFolderUI(); });
}

function showLocalFolderUI() {
    if (document.getElementById('local-folder-panel')) {
        document.getElementById('local-folder-panel').remove();
        return;
    }

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

            var td1 = document.createElement('td');
            td1.style.cssText = 'text-align: right; padding: 4px 15px 4px 4px;';
            var nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = folder;
            nameInput.size = 50;
            nameInput.style.cssText = 'border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px;';
            if (folder === 'Waiting Create') nameInput.readOnly = true;
            nameInput.addEventListener('change', function() { localFolders[idx] = nameInput.value; });
            td1.appendChild(nameInput);

            var td2 = document.createElement('td');
            td2.style.cssText = 'text-align: center; padding: 4px;';
            var orderSelect = document.createElement('select');
            orderSelect.style.cssText = 'width: 80px; font-size: 8pt; border: 1px solid #5C0D12; background: #E0DED3;';
            for (var i = 1; i <= localFolders.length; i++) {
                var opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = String(i);
                if (i === idx + 1) opt.selected = true;
                orderSelect.appendChild(opt);
            }
            orderSelect.addEventListener('change', function() {
                var newIdx = parseInt(orderSelect.value, 10) - 1;
                var moved = localFolders.splice(idx, 1)[0];
                localFolders.splice(newIdx, 0, moved);
                renderRows();
            });
            td2.appendChild(orderSelect);

            var td3 = document.createElement('td');
            td3.style.cssText = 'padding: 4px; text-align: center;';
            if (folder !== 'Waiting Create') {
                var delLink = document.createElement('a');
                delLink.href = '#';
                delLink.textContent = '[Delete]';
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

            tr.appendChild(td1);
            tr.appendChild(td2);
            tr.appendChild(td3);
            tbody.appendChild(tr);
        });
    }

    renderRows();
    table.appendChild(tbody);
    panel.appendChild(table);

    var bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px; align-items: center;';

    var newFolderInput = document.createElement('input');
    newFolderInput.type = 'text';
    newFolderInput.placeholder = 'New folder name';
    newFolderInput.size = 50;
    newFolderInput.style.cssText = 'border: 1px solid #5C0D12; background: #E0DED3; font-size: 9pt; padding: 2px 4px;';

    var createBtn = document.createElement('button');
    createBtn.textContent = 'Create Folder';
    applyPageToneBtnStyle(createBtn, 'padding: 2px 12px;height: 24px;');

    createBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var name = newFolderInput.value.trim();
        if (!name) return;
        if (localFolders.indexOf(name) !== -1) { alert('Folder already exists'); return; }
        localFolders.push(name);
        newFolderInput.value = '';
        renderRows();
    });

    var spacer2 = document.createElement('div'); spacer2.style.cssText = 'flex: 1;';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Changes';
    applyPrimaryDarkBtnStyle(saveBtn, 'padding: 4px 16px;border: none;');
    saveBtn.addEventListener('click', function(e) {
        e.preventDefault();
        saveLocalFolders(localFolders);
        flashButtonSavedState(saveBtn, '已保存 ✓', 'Save Changes', 1500);
    });

    bottomRow.appendChild(newFolderInput);
    bottomRow.appendChild(createBtn);
    bottomRow.appendChild(spacer2);
    bottomRow.appendChild(saveBtn);
    panel.appendChild(bottomRow);

    var scanBtn = document.getElementById('scan-folder-btn');
    if (scanBtn && scanBtn.closest('div')) {
        scanBtn.closest('div').insertAdjacentElement('afterend', panel);
    }
}

function scanFolders() {
    var folderInputs = document.querySelectorAll('input[name^="fn"]');
    var folders = [];
    folderInputs.forEach(function(input) {
        var folderName = input.value.trim();
        if (folderName) folders.push(folderName);
    });
    var uniqueFolders = Array.from(new Set(folders));
    uniqueFolders.sort(function(a, b) { return a.localeCompare(b); });
    GM_setValue('scanned_folders', uniqueFolders);
    opLog('掃描文件夾列表', { count: uniqueFolders.length });
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
    var newLink = document.createElement('a');
    newLink.id = 'auto-create-upload-btn';
    newLink.href = '#';
    newLink.innerHTML = '[Auto Create & Upload]';
    newLink.style.fontWeight = 'normal';
    newDiv.appendChild(newLink);
    lastDiv.insertAdjacentElement('afterend', newDiv);
    newLink.addEventListener('click', function(e) {
        e.preventDefault();
        var existingSection = document.querySelector('.s[data-custom="true"]');
        if (existingSection) {
            existingSection.remove();
            this.style.fontWeight = 'normal';
            return;
        }
        this.style.fontWeight = 'bold';
        createUnpublishedSection(this);
    });
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
            var groups = [];
            var currentGroup = [];
            allTrs.forEach(function(tr) {
                currentGroup.push(tr);
                if (currentGroup.length === 2) { groups.push(currentGroup); currentGroup = []; }
            });
            groups.forEach(function(group) {
                var tr2 = group[1];
                var sid = tr2.dataset.savedDataId;
                if (sid && sid === newVal) {
                    group.forEach(function(tr) { tr.remove(); });
                    removeSavedGalleryById(newVal);
                    deleteGalleryFileListById(newVal);
                    var folderStrong = customSection.querySelector('tr.gtr strong');
                    if (folderStrong) {
                        var count = parseInt(folderStrong.textContent, 10) || 0;
                        folderStrong.textContent = Math.max(0, count - 1);
                    }
                }
            });
            opLog('create_success 已同步移除等待項目', newVal);
            GM_setValue('create_success', null);
        });
    } catch (e) {
        warnLog('Listener', 'GM_addValueChangeListener 不可用', e.message);
    }
}

// ==================== 入口 ====================

function init() {
    try {
        GM_getValue('user_dicts', {});
    } catch (e) {}

    if (!document.getElementById('fifybuj-dragging-cursor-style')) {
        var style = document.createElement('style');
        style.id = 'fifybuj-dragging-cursor-style';
        style.textContent = `
    body.is-dragging, body.is-dragging * {
        cursor: grabbing !important;
        user-select: none !important;
    }
`;
        document.head.appendChild(style);
    }

    _log('=== 庫載入檢查 ===');
    _log('JSZip:', typeof JSZip);
    _log('Kuroshiro:', typeof Kuroshiro);
    _log('KuromojiAnalyzer:', typeof KuromojiAnalyzer);

    initKuroshiro();

    migrateLegacyAuthorizedRootFolderState().catch(function(err) {
        warnLog('Settings', '授權文件夾遷移失敗', err && (err.message || err));
    });

    setTimeout(function() {
        var retries = 0;
        var maxRetries = 3;
        function checkRetry() {
            hasAllExternalDictsDownloaded().then(function(allReady) {
                if (allReady || _autoDictUpdateStarted) return;
                _autoDictUpdateStarted = true;
                flowLog('Init', '檢測到外部字典缺失，開始自動下載');
                return triggerExternalDictUpdate({ disabled: false, textContent: '' }).catch(function(err) {
                    _autoDictUpdateStarted = false;
                    errorLog('Init', '外部字典自動更新失敗', err && err.name ? err.name + ': ' + err.message : err);
                });
            }).catch(function(err) {
                retries++;
                if (retries < maxRetries) {
                    setTimeout(checkRetry, 2000);
                } else {
                    errorLog('Init', '外部字典檢查失敗', err && err.name ? err.name + ': ' + err.message : err);
                }
            });
        }
        checkRetry();
    }, 2000);

    addButtonToPage();
    handleManageGalleryPage();
    setupCreateSuccessListener();

    window.addEventListener('resize', function() {
        document.querySelectorAll('.s[data-custom="true"] td.gtc3').forEach(function(td) {
            var btns = Array.from(td.querySelectorAll('button'));
            if (btns.length > 0) alignSwapBtn(btns, td);
        });
        document.querySelectorAll('.s[data-custom="true"] td.gtc3 span.files-text').forEach(function(span) {
            var td = span.closest('td');
            if (td) alignFilesText(span, td);
        });
    });
}

init();

var observer = new MutationObserver(addButtonToPage);
observer.observe(document.body, { childList: true, subtree: true });

})();
