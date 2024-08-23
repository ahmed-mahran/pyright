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

async function main() {
    const version = process.argv[2];
    await modifyJsonInPlace('package.json', (obj) => {
        obj.version = version;
    })
        .then(() =>
            modifyJsonInPlace('package-lock.json', (obj) => {
                obj.packages[''].version = version;
            })
        )
        .then(() =>
            modifyJsonInPlace('../pyright-internal/package.json', (obj) => {
                obj.version = version;
            })
        )
        .then(() =>
            modifyJsonInPlace('../pyright-internal/package-lock.json', (obj) => {
                obj.packages[''].version = version;
            })
        )
        .then(() =>
            modifyJsonInPlace('../pyright/package.json', (obj) => {
                obj.version = version;
            })
        )
        .then(() =>
            modifyJsonInPlace('../pyright/package-lock.json', (obj) => {
                obj.packages[''].version = version;
            })
        );
}

main();
