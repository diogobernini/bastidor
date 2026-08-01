'use strict';
// Testes do gestor de pendrive (src/main/drives.js): os parsers de saída
// externa usam fixtures gravadas (nada de child_process aqui), e as funções
// de arquivo usam diretórios temporários sintéticos criados por teste.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drives = require('../src/main/drives');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ------------------------------------------------------------------ fixtures: diskutil (darwin)

// Gravado de `diskutil info -plist "/Volumes/USB DISK"` num pendrive FAT32
// real, ligado durante o desenvolvimento (Ejectable/RemovableMedia = true).
const DISKUTIL_USB_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Bootable</key>
	<false/>
	<key>BusProtocol</key>
	<string>USB</string>
	<key>Content</key>
	<string>DOS_FAT_32</string>
	<key>DeviceIdentifier</key>
	<string>disk12s1</string>
	<key>DeviceNode</key>
	<string>/dev/disk12s1</string>
	<key>Ejectable</key>
	<true/>
	<key>FilesystemName</key>
	<string>MS-DOS FAT32</string>
	<key>FilesystemType</key>
	<string>msdos</string>
	<key>FreeSpace</key>
	<integer>3872370688</integer>
	<key>MediaName</key>
	<string></string>
	<key>MountPoint</key>
	<string>/Volumes/USB DISK</string>
	<key>Removable</key>
	<true/>
	<key>RemovableMedia</key>
	<true/>
	<key>SMARTDeviceSpecificKeysMayVaryNotGuaranteed</key>
	<dict/>
	<key>Size</key>
	<integer>3896479744</integer>
	<key>TotalSize</key>
	<integer>3888095232</integer>
	<key>VolumeName</key>
	<string>USB DISK</string>
	<key>Writable</key>
	<true/>
</dict>
</plist>
`;

// Gravado de `diskutil info -plist /` na mesma máquina: volume do sistema
// (APFS interno), Ejectable/RemovableMedia = false. Tem dict e array
// aninhados (APFSPhysicalStores, SMARTDeviceSpecificKeysMayVaryNotGuaranteed)
// para exercitar o parser de plist além do caso plano.
const DISKUTIL_SYSTEM_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>APFSPhysicalStores</key>
	<array>
		<dict>
			<key>APFSPhysicalStore</key>
			<string>disk0s2</string>
		</dict>
	</array>
	<key>Bootable</key>
	<true/>
	<key>Ejectable</key>
	<false/>
	<key>FilesystemName</key>
	<string>APFS</string>
	<key>FreeSpace</key>
	<integer>0</integer>
	<key>MountPoint</key>
	<string>/</string>
	<key>Removable</key>
	<false/>
	<key>RemovableMedia</key>
	<false/>
	<key>SMARTDeviceSpecificKeysMayVaryNotGuaranteed</key>
	<dict>
		<key>AVAILABLE_SPARE</key>
		<integer>100</integer>
		<key>TEMPERATURE</key>
		<integer>305</integer>
	</dict>
	<key>Size</key>
	<integer>1995218165760</integer>
	<key>TotalSize</key>
	<integer>1995186708480</integer>
	<key>VolumeName</key>
	<string>Macintosh HD</string>
	<key>Writable</key>
	<false/>
</dict>
</plist>
`;

// Gravado de `df -k "/Volumes/USB DISK"` na mesma sessão (nome do volume com
// espaço, para garantir que só as 4 primeiras colunas importam).
const DF_USB_OUTPUT =
  'Filesystem    1024-blocks  Used Available Capacity iused ifree %iused  Mounted on\n' +
  '/dev/disk12s1     3796968 15356   3781612     1%       0     0     -   /Volumes/USB DISK\n';

test('parseDiskutilInfoPlist + diskutilInfoToDrive: pendrive FAT32 real é reconhecido', () => {
  const info = drives.parseDiskutilInfoPlist(DISKUTIL_USB_PLIST);
  assert.equal(info.VolumeName, 'USB DISK');
  assert.equal(info.RemovableMedia, true);
  assert.equal(info.Ejectable, true);
  assert.deepEqual(info.SMARTDeviceSpecificKeysMayVaryNotGuaranteed, {});

  const drive = drives.diskutilInfoToDrive(info, '/Volumes/USB DISK', null);
  assert.ok(drive);
  assert.equal(drive.mount, '/Volumes/USB DISK');
  assert.equal(drive.name, 'USB DISK');
  assert.equal(drive.filesystem, 'MS-DOS FAT32');
  assert.equal(drive.capacityBytes, 3888095232);
  assert.equal(drive.freeBytes, 3872370688);
});

test('diskutilInfoToDrive: volume do sistema (não ejetável) é ignorado', () => {
  const info = drives.parseDiskutilInfoPlist(DISKUTIL_SYSTEM_PLIST);
  assert.equal(info.VolumeName, 'Macintosh HD');
  assert.deepEqual(info.APFSPhysicalStores, [{ APFSPhysicalStore: 'disk0s2' }]);

  const drive = drives.diskutilInfoToDrive(info, '/', null);
  assert.equal(drive, null);
});

test('diskutilInfoToDrive: prioriza capacidade/livre do df quando disponível', () => {
  const info = drives.parseDiskutilInfoPlist(DISKUTIL_USB_PLIST);
  const dfInfo = drives.parseDfOutput(DF_USB_OUTPUT);
  const drive = drives.diskutilInfoToDrive(info, '/Volumes/USB DISK', dfInfo);
  // df e plist concordam nesta captura, mas o contrato é: vem do df quando existe.
  assert.equal(drive.capacityBytes, dfInfo.capacityBytes);
  assert.equal(drive.freeBytes, dfInfo.freeBytes);
});

test('parseDfOutput: lê device e bytes (KB -> bytes) de um mount com espaço no nome', () => {
  const info = drives.parseDfOutput(DF_USB_OUTPUT);
  assert.equal(info.device, '/dev/disk12s1');
  assert.equal(info.capacityBytes, 3796968 * 1024);
  assert.equal(info.freeBytes, 3781612 * 1024);
});

test('parseDfOutput: entrada vazia ou sem linha de dados devolve null', () => {
  assert.equal(drives.parseDfOutput(''), null);
  assert.equal(
    drives.parseDfOutput('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n'),
    null
  );
});

// ------------------------------------------------------------------ fixtures: PowerShell (win32)

test('parseWin32LogicalDiskJson: um único pendrive (ConvertTo-Json devolve objeto solto)', () => {
  // Sem -AsArray, um Select-Object de 1 resultado sai como objeto, não array.
  const json = '{\n    "DeviceID":  "E:",\n    "VolumeName":  "PENDRIVE",\n    "Size":  8004239360,\n' +
    '    "FreeSpace":  4001234432,\n    "FileSystem":  "FAT32"\n}';
  const list = drives.parseWin32LogicalDiskJson(json);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    mount: 'E:\\',
    name: 'PENDRIVE',
    filesystem: 'FAT32',
    capacityBytes: 8004239360,
    freeBytes: 4001234432,
  });
});

test('parseWin32LogicalDiskJson: múltiplos pendrives (array) e VolumeName vazio', () => {
  const json = JSON.stringify([
    { DeviceID: 'E:', VolumeName: '', Size: 16008478720, FreeSpace: 12000000000, FileSystem: 'FAT32' },
    { DeviceID: 'F:', VolumeName: 'BACKUP', Size: 32016957440, FreeSpace: 100000000, FileSystem: 'NTFS' },
  ]);
  const list = drives.parseWin32LogicalDiskJson(json);
  assert.equal(list.length, 2);
  assert.equal(list[0].mount, 'E:\\');
  assert.equal(list[0].name, 'E:'); // sem VolumeName, cai para o DeviceID
  assert.equal(list[1].filesystem, 'NTFS');
});

test('parseWin32LogicalDiskJson: nenhum pendrive (saída vazia ou "null")', () => {
  assert.deepEqual(drives.parseWin32LogicalDiskJson(''), []);
  assert.deepEqual(drives.parseWin32LogicalDiskJson('null'), []);
  assert.deepEqual(drives.parseWin32LogicalDiskJson('not json at all'), []);
});

// ------------------------------------------------------------------ scanDesigns

test('scanDesigns: acha extensões suportadas, ignora ocultos e respeita a profundidade', () => {
  const root = makeTmpDir('bastidor-scan-');
  try {
    fs.writeFileSync(path.join(root, 'rosa.dst'), 'x');
    fs.writeFileSync(path.join(root, 'nota.txt'), 'x'); // extensão não suportada
    fs.writeFileSync(path.join(root, '.oculto.dst'), 'x'); // arquivo oculto
    fs.mkdirSync(path.join(root, '.pasta-oculta'));
    fs.writeFileSync(path.join(root, '.pasta-oculta', 'escondido.jef'), 'x');

    const deep = path.join(root, 'n1', 'n2', 'n3', 'n4');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'achado.PES'), 'x'); // extensão maiúscula, dir de profundidade 4
    fs.mkdirSync(path.join(deep, 'n5'));
    fs.writeFileSync(path.join(deep, 'n5', 'fundo-demais.exp'), 'x'); // profundidade 5: fora do limite

    const found = drives.scanDesigns(root).map((d) => d.name).sort();
    assert.deepEqual(found, ['achado.PES', 'rosa.dst']);

    const rosa = drives.scanDesigns(root).find((d) => d.name === 'rosa.dst');
    assert.equal(rosa.sizeBytes, 1);
    assert.equal(typeof rosa.mtime, 'number');
    assert.equal(rosa.path, path.join(root, 'rosa.dst'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanDesigns: pasta inexistente devolve lista vazia (não lança)', () => {
  assert.deepEqual(drives.scanDesigns('/caminho/que/nao/existe/de/verdade'), []);
});

// ------------------------------------------------------------------ cleanHiddenFiles

test('cleanHiddenFiles: remove só ._* e .DS_Store, preserva o resto', () => {
  const root = makeTmpDir('bastidor-clean-');
  try {
    fs.writeFileSync(path.join(root, '._a.dst'), 'x');
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, 'design.dst'), 'x');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', '._b.jef'), 'x');
    fs.writeFileSync(path.join(root, 'sub', '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'outro.pes'), 'x');

    const removed = drives.cleanHiddenFiles(root);
    assert.equal(removed, 4);

    assert.deepEqual(fs.readdirSync(root).sort(), ['design.dst', 'sub']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'sub')).sort(), ['outro.pes']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanHiddenFiles: nunca segue links simbólicos nem sai da raiz', () => {
  const root = makeTmpDir('bastidor-clean-root-');
  const outside = makeTmpDir('bastidor-clean-outside-');
  try {
    const sentinel = path.join(outside, '._sentinela.dst');
    fs.writeFileSync(sentinel, 'não deveria ser removido');

    // Link dentro do drive, nomeado como se fosse AppleDouble, apontando para fora.
    fs.symlinkSync(outside, path.join(root, '._link-malicioso'));
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');

    const removed = drives.cleanHiddenFiles(root);

    assert.equal(removed, 1); // só o .DS_Store real dentro da raiz
    assert.ok(fs.existsSync(sentinel), 'arquivo fora da raiz não deveria ser afetado');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('cleanHiddenFiles: pasta vazia ou inexistente devolve 0 (não lança)', () => {
  const root = makeTmpDir('bastidor-clean-empty-');
  try {
    assert.equal(drives.cleanHiddenFiles(root), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(drives.cleanHiddenFiles('/caminho/que/nao/existe/de/verdade'), 0);
});

// ------------------------------------------------------------------ copyFiles / deleteWithinRoot

test('copyFiles: copia, detecta conflito sem sobrescrever e respeita overwrite:true', () => {
  const root = makeTmpDir('bastidor-copy-src-');
  const destDir = makeTmpDir('bastidor-copy-dest-');
  try {
    const src = path.join(root, 'matriz.xxx');
    fs.writeFileSync(src, 'conteudo original');

    const first = drives.copyFiles([src], destDir);
    assert.equal(first[0].status, 'copied');
    assert.equal(fs.readFileSync(first[0].dest, 'utf8'), 'conteudo original');

    fs.writeFileSync(src, 'conteudo novo'); // muda o arquivo de origem
    const conflict = drives.copyFiles([src], destDir);
    assert.equal(conflict[0].status, 'conflict');
    assert.equal(fs.readFileSync(path.join(destDir, 'matriz.xxx'), 'utf8'), 'conteudo original'); // intacto

    const forced = drives.copyFiles([src], destDir, { overwrite: true });
    assert.equal(forced[0].status, 'copied');
    assert.equal(fs.readFileSync(path.join(destDir, 'matriz.xxx'), 'utf8'), 'conteudo novo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('deleteWithinRoot: apaga dentro da raiz e recusa qualquer caminho fora dela', () => {
  const root = makeTmpDir('bastidor-delete-');
  const outsideFile = path.join(os.tmpdir(), 'bastidor-nao-apagar.txt');
  try {
    const inside = path.join(root, 'matriz.dst');
    fs.writeFileSync(inside, 'x');
    fs.writeFileSync(outsideFile, 'x');

    const results = drives.deleteWithinRoot([inside, outsideFile], root);
    const byPath = Object.fromEntries(results.map((r) => [r.path, r]));

    assert.equal(byPath[inside].ok, true);
    assert.ok(!fs.existsSync(inside));

    assert.equal(byPath[outsideFile].ok, false);
    assert.ok(fs.existsSync(outsideFile), 'arquivo fora da raiz não deveria ser apagado');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});

// ------------------------------------------------------------------ formatBytes

test('formatBytes: formata bytes/KB/MB/GB e casos inválidos', () => {
  assert.equal(drives.formatBytes(0), '0 B');
  assert.equal(drives.formatBytes(500), '500 B');
  assert.equal(drives.formatBytes(1024), '1.00 KB');
  assert.equal(drives.formatBytes(1536), '1.50 KB');
  assert.equal(drives.formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(drives.formatBytes(3888095232), '3.62 GB');
  assert.equal(drives.formatBytes(-1), '—');
  assert.equal(drives.formatBytes(null), '—');
  assert.equal(drives.formatBytes(undefined), '—');
  assert.equal(drives.formatBytes(NaN), '—');
});

// ------------------------------------------------------------------ listRemovableDrives (fake)

test('listRemovableDrives: --fake-drive apresenta a pasta como um pendrive "FAKE"', () => {
  const root = makeTmpDir('bastidor-fake-parent-');
  try {
    const fakeDir = path.join(root, 'fakedrive-nao-existe-ainda');
    const list = drives.listRemovableDrives({ fakeDrivePath: fakeDir });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'FAKE');
    assert.equal(list[0].mount, path.resolve(fakeDir));
    assert.equal(list[0].fake, true);
    assert.ok(fs.existsSync(fakeDir), 'a pasta do drive falso deveria ser criada sob demanda');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
