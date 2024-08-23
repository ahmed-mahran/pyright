/* eslint-disable @typescript-eslint/no-var-requires */
//@ts-check

const { promises: fsAsync } = require('fs');

/**
 * @param {string} filepath
 * @param {(obj: any) => void} modifier
 */
async function modifyJsonInPlace(filepath, modifier) {
    const input = await fsAsync.readFile(filepath, 'utf-8');
    const obj = JSON.parse(input);

    modifier(obj);

    // Always 4 spaces for indent.
    let output = JSON.stringify(obj, null, 4);

    if (input.endsWith('\n')) {
        output += '\n';
    }

    if (input.indexOf('\r\n') !== -1) {
        output = output.replace(/\n/g, '\r\n');
    }

    await fsAsync.writeFile(filepath, output, 'utf-8');
}

/**
 * @param {string} path
 * @param {string} version
 */
async function setVersionFor(path, version) {
    await modifyJsonInPlace(path + 'package.json', (obj) => {
        obj.version = version;
    }).then(() =>
        modifyJsonInPlace(path + 'package-lock.json', (obj) => {
            obj.packages[''].version = version;
        })
    );
}

async function main() {
    const mypyrightVersion = process.argv[2];
    const pyrightVersion = process.argv[3];
    await setVersionFor('', mypyrightVersion)
        .then(() => setVersionFor('../pyright-internal/', pyrightVersion))
        .then(() => setVersionFor('../pyright/', pyrightVersion));
}

main();
