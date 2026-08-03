const fs = require('fs');
const path = require('path');
function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.js')) {
      results.push(file);
    }
  });
  return results;
}
const files = walk('src');
let changed = 0;
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  // Match prisma.subscription.findFirst or findMany up to orderBy: { createdAt: "desc" }
  const regex = /(prisma\.subscription\.find(?:First|Many)\s*\([\s\S]*?orderBy\s*:\s*\{\s*)createdAt(\s*:\s*(?:\"|\')desc(?:\"|\')\s*\})/g;
  if (regex.test(content)) {
    const newContent = content.replace(regex, '$1startsAt$2');
    fs.writeFileSync(file, newContent);
    changed++;
    console.log('Fixed ' + file);
  }
});
console.log('Total fixed: ' + changed);
