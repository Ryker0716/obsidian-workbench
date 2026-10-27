/*
 * 极简 obsidian API 存根：只为在 Node 里 require 插件、跑纯函数测试。
 * 不模拟任何真实行为，插件加载时的副作用也都在 onload 里（不会被调用）。
 */
class Plugin {}
class ItemView {}
class Modal {}
class Notice {}
class Setting {}
class PluginSettingTab {}
class TFile {}
function debounce(fn) {
	let t = null;
	const wrapped = (...a) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...a), 0);
	};
	wrapped.cancel = () => clearTimeout(t);
	return wrapped;
}
module.exports = { Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile, debounce };
