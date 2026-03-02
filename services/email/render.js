"use strict";

/**
 * Simple token renderer: replaces {Token} with vars.Token.
 * Missing tokens render as empty string.
 */
function renderString(template, vars) {
  return String(template || "").replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key) => {
    const v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
    return v === null || v === undefined ? "" : String(v);
  });
}

function renderTemplatePack(tpl, vars) {
  return {
    subject: renderString(tpl.subject, vars),
    preheader: renderString(tpl.preheader, vars),
    body_text: renderString(tpl.body_text, vars),
    body_html: renderString(tpl.body_html, vars),
    cta_label: renderString(tpl.cta_label, vars),
  };
}

module.exports = { renderString, renderTemplatePack };
