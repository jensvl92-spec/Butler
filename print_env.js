
const fs = require('fs');
try {
    const env = fs.readFileSync('.env', 'utf8');
    console.log(env);
} catch (e) {
    console.error(e);
}
