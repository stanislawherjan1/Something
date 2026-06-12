const fs = require('fs');
const wb = process.argv[2];
if (!wb) { console.error('Usage: node inject.js <workbench.html>'); process.exit(1); }
let html = fs.readFileSync(wb, 'utf8');
const css = fs.readFileSync('/opt/ide/overrides.css', 'utf8').replace(/\n/g, ' ');
const js = fs.readFileSync('/opt/ide/mobile.js', 'utf8').replace(/\n/g, ' ');
const inject = '<style>' + css + '</style><script>' + js + '</script>';
html = html.replace('</head>', inject + '</head>');
fs.writeFileSync(wb, html);
console.log('CSS + JS injected into ' + wb);
