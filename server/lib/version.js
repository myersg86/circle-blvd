// Get the version of the package we're a part of.
// Assumes the package is one directory up.

var fs = require('fs');
var path = require('path');
var version = "0.0.0";

var packagePath = path.join(__dirname, "..", "package.json");
try {
    var data = fs.readFileSync(packagePath, "utf-8");
    var packageJson = JSON.parse(data);
    version = packageJson.version;
}
catch (e) {
    console.log("index: Could not read package.json at: " + packagePath);
}

module.exports = function () {
    return version;
}();