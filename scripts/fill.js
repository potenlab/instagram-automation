// Replace every {{key}} placeholder with data[key] (missing key → '').
module.exports = function fill(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] ?? '');
};
