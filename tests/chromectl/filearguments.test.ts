/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

/**
 * The front runs `chromectl/` as plain ESM straight from the source tree,
 * outside the TypeScript program, and this test loads the very same files the
 * same way rather than a compiled copy of them.
 */
const FILE_ARGUMENTS_MODULE = path.resolve('chromectl/filearguments.mjs');

const COMMANDS_MODULE = pathToFileURL(
  path.resolve('chromectl/commands.mjs'),
).href;

const FILENAMES_MODULE = pathToFileURL(
  path.resolve('chromectl/filenames.mjs'),
).href;

interface ArgumentSpec {
  direction: string;
  kind?: string;
  extensions?: string[];
}

type FileArgumentTable = Record<string, Record<string, ArgumentSpec>>;

interface FileArguments {
  FILE_ARGUMENTS: FileArgumentTable;
  assertArgumentsAccountedFor(
    schemas?: Map<string, Record<string, unknown>>,
    fileArguments?: FileArgumentTable,
    nonPathArguments?: Set<string>,
    scopedNonPathArguments?: Set<string>,
  ): void;
  assertExtensionsAccountedFor(
    fileArguments?: FileArgumentTable,
    extensions?: string[],
    contentTypes?: Record<string, string>,
  ): void;
}

/** A tool the command table does not know, carrying a path nobody accounted for. */
const UNKNOWN_ARGUMENT_SCHEMAS = new Map([
  ['fake_tool', {mysteryPath: {name: 'mysteryPath', type: 'string'}}],
]);

/** An argument named after a property every object carries on its prototype. */
const INHERITED_NAME_SCHEMAS = new Map([
  ['take_screenshot', {constructor: {name: 'constructor', type: 'string'}}],
]);

/** `input` on the command that owns it and on one that never declared it. */
const SCOPED_NAME_SCHEMAS = new Map([
  ['execute_webmcp_tool', {input: {name: 'input', type: 'string'}}],
  ['navigate_page', {input: {name: 'input', type: 'string'}}],
]);

/** `input` on the command that owns it, alone. */
const OWNED_NAME_SCHEMAS = new Map([
  ['execute_webmcp_tool', {input: {name: 'input', type: 'string'}}],
]);

/** A path argument whose ending the front has no name and no media type for. */
const UNKNOWN_ENDING_ARGUMENTS: FileArgumentTable = {
  fake_tool: {
    filePath: {direction: 'out', kind: 'mystery', extensions: ['mystery']},
  },
};

/**
 * A module beside the copy under test that hands on the real one unchanged.
 * The copy resolves both neighbours next to itself, so both have to be there
 * whichever of them a case doctors.
 */
function passthrough(module: string): string {
  return `export * from '${module}';\n`;
}

/** The command table with one tool in it that carries an unaccounted argument. */
const DOCTORED_COMMANDS =
  passthrough(COMMANDS_MODULE) +
  `import {COMMAND_SCHEMAS as declared} from '${COMMANDS_MODULE}';\n` +
  `export const COMMAND_SCHEMAS = new Map([...declared, ` +
  `['fake_tool', {mysteryPath: {name: 'mysteryPath', type: 'string'}}]]);\n`;

/** The served endings with the one a snapshot carries taken out of them. */
const DOCTORED_FILENAMES =
  passthrough(FILENAMES_MODULE) +
  `import {FILE_EXTENSIONS as served} from '${FILENAMES_MODULE}';\n` +
  `export const FILE_EXTENSIONS = served.filter(ending => ending !== 'txt');\n`;

describe('chromectl front argument tables', () => {
  let tables: FileArguments;
  const copies: string[] = [];

  /**
   * Imports a copy of the module beside neighbours this test wrote. The copy is
   * the file the front loads, byte for byte, while the tables it holds against
   * each other are the doctored ones — so an import that goes through without a
   * word says the check no longer runs at load, whatever the checking function
   * itself still does when it is called.
   */
  async function importCopyBeside(
    commands: string,
    filenames: string,
  ): Promise<void> {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'chromectl-arguments-'),
    );
    copies.push(directory);
    fs.writeFileSync(path.join(directory, 'commands.mjs'), commands, 'utf8');
    fs.writeFileSync(path.join(directory, 'filenames.mjs'), filenames, 'utf8');
    const copy = path.join(directory, 'filearguments.mjs');
    fs.copyFileSync(FILE_ARGUMENTS_MODULE, copy);
    await import(pathToFileURL(copy).href);
  }

  before(async () => {
    tables = (await import(
      pathToFileURL(FILE_ARGUMENTS_MODULE).href
    )) as FileArguments;
  });

  after(() => {
    for (const directory of copies) {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('accounts for every argument the command table declares', () => {
    assert.doesNotThrow(() => tables.assertArgumentsAccountedFor());
    assert.ok(Object.keys(tables.FILE_ARGUMENTS).length > 0);
  });

  it('refuses an argument that is in neither table', () => {
    assert.throws(
      () => tables.assertArgumentsAccountedFor(UNKNOWN_ARGUMENT_SCHEMAS),
      /fake_tool\.mysteryPath/,
    );
  });

  it('refuses an argument named after an inherited property', () => {
    assert.throws(
      () => tables.assertArgumentsAccountedFor(INHERITED_NAME_SCHEMAS),
      /take_screenshot\.constructor/,
    );
  });

  it('refuses a name on a command other than the one that declares it', () => {
    assert.throws(
      () => tables.assertArgumentsAccountedFor(SCOPED_NAME_SCHEMAS),
      /navigate_page\.input/,
    );
    assert.doesNotThrow(() =>
      tables.assertArgumentsAccountedFor(OWNED_NAME_SCHEMAS),
    );
  });

  it('accounts for every ending a call can produce', () => {
    assert.doesNotThrow(() => tables.assertExtensionsAccountedFor());
  });

  it('refuses an ending the file route does not serve', () => {
    assert.throws(
      () => tables.assertExtensionsAccountedFor(UNKNOWN_ENDING_ARGUMENTS),
      /\.mystery \(fake_tool\.filePath\)/,
    );
  });

  it('refuses an ending nothing says what to serve it as', () => {
    assert.throws(
      () =>
        tables.assertExtensionsAccountedFor(
          UNKNOWN_ENDING_ARGUMENTS,
          ['mystery'],
          {},
        ),
      /\.mystery \(fake_tool\.filePath\)/,
    );
  });

  it('holds the arguments against the tables when it is loaded', async () => {
    await assert.rejects(
      importCopyBeside(DOCTORED_COMMANDS, passthrough(FILENAMES_MODULE)),
      /fake_tool\.mysteryPath/,
    );
  });

  it('holds the endings against the tables when it is loaded', async () => {
    await assert.rejects(
      importCopyBeside(passthrough(COMMANDS_MODULE), DOCTORED_FILENAMES),
      /\.txt \(take_snapshot\.filePath\)/,
    );
  });
});
