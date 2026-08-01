'use strict';
// Tabelas de fios de fábrica, portadas de pystitch (MIT, inkstitch/pystitch):
// EmbThreadPec.py (Brother), EmbThreadJef.py (Janome), EmbThreadHus.py (Husqvarna)
// e EmbThreadSew.py (Janome/SEW).
// O índice 0 é null nas paletas PEC/JEF (marcador de "sem fio"/parada); HUS e SEW
// não têm esse marcador — o índice lido do arquivo indexa a paleta diretamente.
// Também traz o casamento de cor mais próxima (EmbThread.py: color_distance_red_mean
// / find_nearest_color_index / build_unique_palette), usado pelos writers PEC/PES/JEF.

const { Thread, threadsEqual } = require('./pattern');

function pec(r, g, b, description, catalog) {
  const t = new Thread((r << 16) | (g << 8) | b);
  t.description = description;
  t.catalogNumber = catalog;
  t.brand = 'Brother';
  t.chart = 'Brother';
  return t;
}

function jef(color, description, catalog) {
  const t = new Thread(color);
  t.description = description;
  t.catalogNumber = catalog;
  t.brand = 'Jef';
  t.chart = 'Jef';
  return t;
}

function getPecThreadSet() {
  return [
    null,
    pec(14, 31, 124, 'Prussian Blue', '1'),
    pec(10, 85, 163, 'Blue', '2'),
    pec(0, 135, 119, 'Teal Green', '3'),
    pec(75, 107, 175, 'Cornflower Blue', '4'),
    pec(237, 23, 31, 'Red', '5'),
    pec(209, 92, 0, 'Reddish Brown', '6'),
    pec(145, 54, 151, 'Magenta', '7'),
    pec(228, 154, 203, 'Light Lilac', '8'),
    pec(145, 95, 172, 'Lilac', '9'),
    pec(158, 214, 125, 'Mint Green', '10'),
    pec(232, 169, 0, 'Deep Gold', '11'),
    pec(254, 186, 53, 'Orange', '12'),
    pec(255, 255, 0, 'Yellow', '13'),
    pec(112, 188, 31, 'Lime Green', '14'),
    pec(186, 152, 0, 'Brass', '15'),
    pec(168, 168, 168, 'Silver', '16'),
    pec(125, 111, 0, 'Russet Brown', '17'),
    pec(255, 255, 179, 'Cream Brown', '18'),
    pec(79, 85, 86, 'Pewter', '19'),
    pec(0, 0, 0, 'Black', '20'),
    pec(11, 61, 145, 'Ultramarine', '21'),
    pec(119, 1, 118, 'Royal Purple', '22'),
    pec(41, 49, 51, 'Dark Gray', '23'),
    pec(42, 19, 1, 'Dark Brown', '24'),
    pec(246, 74, 138, 'Deep Rose', '25'),
    pec(178, 118, 36, 'Light Brown', '26'),
    pec(252, 187, 197, 'Salmon Pink', '27'),
    pec(254, 55, 15, 'Vermilion', '28'),
    pec(240, 240, 240, 'White', '29'),
    pec(106, 28, 138, 'Violet', '30'),
    pec(168, 221, 196, 'Seacrest', '31'),
    pec(37, 132, 187, 'Sky Blue', '32'),
    pec(254, 179, 67, 'Pumpkin', '33'),
    pec(255, 243, 107, 'Cream Yellow', '34'),
    pec(208, 166, 96, 'Khaki', '35'),
    pec(209, 84, 0, 'Clay Brown', '36'),
    pec(102, 186, 73, 'Leaf Green', '37'),
    pec(19, 74, 70, 'Peacock Blue', '38'),
    pec(135, 135, 135, 'Gray', '39'),
    pec(216, 204, 198, 'Warm Gray', '40'),
    pec(67, 86, 7, 'Dark Olive', '41'),
    pec(253, 217, 222, 'Flesh Pink', '42'),
    pec(249, 147, 188, 'Pink', '43'),
    pec(0, 56, 34, 'Deep Green', '44'),
    pec(178, 175, 212, 'Lavender', '45'),
    pec(104, 106, 176, 'Wisteria Violet', '46'),
    pec(239, 227, 185, 'Beige', '47'),
    pec(247, 56, 102, 'Carmine', '48'),
    pec(181, 75, 100, 'Amber Red', '49'),
    pec(19, 43, 26, 'Olive Green', '50'),
    pec(199, 1, 86, 'Dark Fuchsia', '51'),
    pec(254, 158, 50, 'Tangerine', '52'),
    pec(168, 222, 235, 'Light Blue', '53'),
    pec(0, 103, 62, 'Emerald Green', '54'),
    pec(78, 41, 144, 'Purple', '55'),
    pec(47, 126, 32, 'Moss Green', '56'),
    pec(255, 204, 204, 'Flesh Pink', '57'),
    pec(255, 217, 17, 'Harvest Gold', '58'),
    pec(9, 91, 166, 'Electric Blue', '59'),
    pec(240, 249, 112, 'Lemon Yellow', '60'),
    pec(227, 243, 91, 'Fresh Green', '61'),
    pec(255, 153, 0, 'Orange', '62'),
    pec(255, 240, 141, 'Cream Yellow', '63'),
    pec(255, 200, 200, 'Applique', '64'),
  ];
}

function getJefThreadSet() {
  return [
    null,
    jef(0x000000, 'Black', '002'),
    jef(0xffffff, 'White', '001'),
    jef(0xffff17, 'Yellow', '204'),
    jef(0xff6600, 'Orange', '203'),
    jef(0x2f5933, 'Olive Green', '219'),
    jef(0x237336, 'Green', '226'),
    jef(0x65c2c8, 'Sky', '217'),
    jef(0xab5a96, 'Purple', '208'),
    jef(0xf669a0, 'Pink', '201'),
    jef(0xff0000, 'Red', '225'),
    jef(0xb1704e, 'Brown', '214'),
    jef(0x0b2f84, 'Blue', '207'),
    jef(0xe4c35d, 'Gold', '003'),
    jef(0x481a05, 'Dark Brown', '205'),
    jef(0xac9cc7, 'Pale Violet', '209'),
    jef(0xfcf294, 'Pale Yellow', '210'),
    jef(0xf999b7, 'Pale Pink', '211'),
    jef(0xfab381, 'Peach', '212'),
    jef(0xc9a480, 'Beige', '213'),
    jef(0x970533, 'Wine Red', '215'),
    jef(0xa0b8cc, 'Pale Sky', '216'),
    jef(0x7fc21c, 'Yellow Green', '218'),
    jef(0xe5e5e5, 'Silver Gray', '220'),
    jef(0x889b9b, 'Gray', '221'),
    jef(0x98d6bd, 'Pale Aqua', '227'),
    jef(0xb2e1e3, 'Baby Blue', '228'),
    jef(0x368ba0, 'Powder Blue', '229'),
    jef(0x4f83ab, 'Bright Blue', '230'),
    jef(0x386a91, 'Slate Blue', '231'),
    jef(0x071650, 'Navy Blue', '232'),
    jef(0xf999a2, 'Salmon Pink', '233'),
    jef(0xf9676b, 'Coral', '234'),
    jef(0xe3311f, 'Burnt Orange', '235'),
    jef(0xe2a188, 'Cinnamon', '236'),
    jef(0xb59474, 'Umber', '237'),
    jef(0xe4cf99, 'Blond', '238'),
    jef(0xffcb00, 'Sunflower', '239'),
    jef(0xe1add4, 'Orchid Pink', '240'),
    jef(0xc3007e, 'Peony Purple', '241'),
    jef(0x80004b, 'Burgundy', '242'),
    jef(0x540571, 'Royal Purple', '243'),
    jef(0xb10525, 'Cardinal Red', '244'),
    jef(0xcae0c0, 'Opal Green', '245'),
    jef(0x899856, 'Moss Green', '246'),
    jef(0x5c941a, 'Meadow Green', '247'),
    jef(0x003114, 'Dark Green', '248'),
    jef(0x5dae94, 'Aquamarine', '249'),
    jef(0x4cbf8f, 'Emerald Green', '250'),
    jef(0x007772, 'Peacock Green', '251'),
    jef(0x595b61, 'Dark Gray', '252'),
    jef(0xfffff2, 'Ivory White', '253'),
    jef(0xb15818, 'Hazel', '254'),
    jef(0xcb8a07, 'Toast', '255'),
    jef(0x986c80, 'Salmon', '256'),
    jef(0x98692d, 'Cocoa Brown', '257'),
    jef(0x4d3419, 'Sienna', '258'),
    jef(0x4c330b, 'Sepia', '259'),
    jef(0x33200a, 'Dark Sepia', '260'),
    jef(0x523a97, 'Violet Blue', '261'),
    jef(0x0d217e, 'Blue Ink', '262'),
    jef(0x1e77ac, 'Sola Blue', '263'),
    jef(0xb2dd53, 'Green Dust', '264'),
    jef(0xf33689, 'Crimson', '265'),
    jef(0xde649e, 'Floral Pink', '266'),
    jef(0x984161, 'Wine', '267'),
    jef(0x4c5612, 'Olive Drab', '268'),
    jef(0x4c881f, 'Meadow', '269'),
    jef(0xe4de79, 'Mustard', '270'),
    jef(0xcb8a1a, 'Yellow Ocher', '271'),
    jef(0xcba21c, 'Old Gold', '272'),
    jef(0xff9805, 'Honey Dew', '273'),
    jef(0xfcb257, 'Tangerine', '274'),
    jef(0xffe505, 'Canary Yellow', '275'),
    jef(0xf0331f, 'Vermilion', '202'),
    jef(0x1a842d, 'Bright Green', '206'),
    jef(0x386cae, 'Ocean Blue', '222'),
    jef(0xe3c4b4, 'Beige Gray', '223'),
    jef(0xe3ac81, 'Bamboo', '224'),
  ];
}

function hus(hex, description, catalog) {
  const t = new Thread(hex);
  t.description = description;
  t.catalogNumber = catalog;
  t.brand = 'Hus';
  t.chart = 'Hus';
  return t;
}

function sew(r, g, b, description, catalog) {
  const t = new Thread((r << 16) | (g << 8) | b);
  t.description = description;
  t.catalogNumber = catalog;
  t.brand = 'Sew';
  t.chart = 'Sew';
  return t;
}

// EmbThreadHus.get_thread_set(): 29 cores, sem marcador nulo — o índice do
// arquivo (u16le) indexa este array diretamente (sem módulo no pystitch).
function getHusThreadSet() {
  return [
    hus('#000000', 'Black', '026'),
    hus('#0000e7', 'Blue', '005'),
    hus('#00c600', 'Green', '002'),
    hus('#ff0000', 'Red', '014'),
    hus('#840084', 'Purple', '008'),
    hus('#ffff00', 'Yellow', '020'),
    hus('#848484', 'Grey', '024'),
    hus('#8484e7', 'Light Blue', '006'),
    hus('#00ff84', 'Light Green', '003'),
    hus('#ff7b31', 'Orange', '017'),
    hus('#ff8ca5', 'Pink', '011'),
    hus('#845200', 'Brown', '028'),
    hus('#ffffff', 'White', '022'),
    hus('#000084', 'Dark Blue', '004'),
    hus('#008400', 'Dark Green', '001'),
    hus('#7b0000', 'Dark Red', '013'),
    hus('#ff6384', 'Light Red', '015'),
    hus('#522952', 'Dark Purple', '007'),
    hus('#ff00ff', 'Light Purple', '009'),
    hus('#ffde00', 'Dark Yellow', '019'),
    hus('#ffff9c', 'Light Yellow', '021'),
    hus('#525252', 'Dark Grey', '025'),
    hus('#d6d6d6', 'Light Grey', '023'),
    hus('#ff5208', 'Dark Orange', '016'),
    hus('#ff9c5a', 'Light Orange', '018'),
    hus('#ff52b5', 'Dark Pink', '010'),
    hus('#ffc6de', 'Light Pink', '012'),
    hus('#523100', 'Dark Brown', '027'),
    hus('#b5a584', 'Light Brown', '029'),
  ];
}

// EmbThreadSew.get_thread_set(): 79 cores, índice 0 = "Unknown" (preto) — o
// leitor aplica módulo (index %= 79), então qualquer índice fora da faixa cai
// numa cor válida em vez de estourar.
function getSewThreadSet() {
  return [
    sew(0, 0, 0, 'Unknown', '0'),
    sew(0, 0, 0, 'Black', '1'),
    sew(255, 255, 255, 'White', '2'),
    sew(255, 255, 23, 'Sunflower', '3'),
    sew(250, 160, 96, 'Hazel', '4'),
    sew(92, 118, 73, 'Green Dust', '5'),
    sew(64, 192, 48, 'Green', '6'),
    sew(101, 194, 200, 'Sky', '7'),
    sew(172, 128, 190, 'Purple', '8'),
    sew(245, 188, 203, 'Pink', '9'),
    sew(255, 0, 0, 'Red', '10'),
    sew(192, 128, 0, 'Brown', '11'),
    sew(0, 0, 240, 'Blue', '12'),
    sew(228, 195, 93, 'Gold', '13'),
    sew(165, 42, 42, 'Dark Brown', '14'),
    sew(213, 176, 212, 'Pale Violet', '15'),
    sew(252, 242, 148, 'Pale Yellow', '16'),
    sew(240, 208, 192, 'Pale Pink', '17'),
    sew(255, 192, 0, 'Peach', '18'),
    sew(201, 164, 128, 'Beige', '19'),
    sew(155, 61, 75, 'Wine Red', '20'),
    sew(160, 184, 204, 'Pale Sky', '21'),
    sew(127, 194, 28, 'Yellow Green', '22'),
    sew(185, 185, 185, 'Silver Grey', '23'),
    sew(160, 160, 160, 'Grey', '24'),
    sew(152, 214, 189, 'Pale Aqua', '25'),
    sew(184, 240, 240, 'Baby Blue', '26'),
    sew(54, 139, 160, 'Powder Blue', '27'),
    sew(79, 131, 171, 'Bright Blue', '28'),
    sew(56, 106, 145, 'Slate Blue', '29'),
    sew(0, 32, 107, 'Nave Blue', '30'),
    sew(229, 197, 202, 'Salmon Pink', '31'),
    sew(249, 103, 107, 'Coral', '32'),
    sew(227, 49, 31, 'Burnt Orange', '33'),
    sew(226, 161, 136, 'Cinnamon', '34'),
    sew(181, 148, 116, 'Umber', '35'),
    sew(228, 207, 153, 'Blonde', '36'),
    sew(225, 203, 0, 'Sunflower', '37'),
    sew(225, 173, 212, 'Orchid Pink', '38'),
    sew(195, 0, 126, 'Peony Purple', '39'),
    sew(128, 0, 75, 'Burgundy', '40'),
    sew(160, 96, 176, 'Royal Purple', '41'),
    sew(192, 64, 32, 'Cardinal Red', '42'),
    sew(202, 224, 192, 'Opal Green', '43'),
    sew(137, 152, 86, 'Moss Green', '44'),
    sew(0, 170, 0, 'Meadow Green', '45'),
    sew(33, 138, 33, 'Dark Green', '46'),
    sew(93, 174, 148, 'Aquamarine', '47'),
    sew(76, 191, 143, 'Emerald Green', '48'),
    sew(0, 119, 114, 'Peacock Green', '49'),
    sew(112, 112, 112, 'Dark Grey', '50'),
    sew(242, 255, 255, 'Ivory White', '51'),
    sew(177, 88, 24, 'Hazel', '52'),
    sew(203, 138, 7, 'Toast', '53'),
    sew(247, 146, 123, 'Salmon', '54'),
    sew(152, 105, 45, 'Cocoa Brown', '55'),
    sew(162, 113, 72, 'Sienna', '56'),
    sew(123, 85, 74, 'Sepia', '57'),
    sew(79, 57, 70, 'Dark Sepia', '58'),
    sew(82, 58, 151, 'Violet Blue', '59'),
    sew(0, 0, 160, 'Blue Ink', '60'),
    sew(0, 150, 222, 'Solar Blue', '61'),
    sew(178, 221, 83, 'Green Dust', '62'),
    sew(250, 143, 187, 'Crimson', '63'),
    sew(222, 100, 158, 'Floral Pink', '64'),
    sew(181, 80, 102, 'Wine', '65'),
    sew(94, 87, 71, 'Olive Drab', '66'),
    sew(76, 136, 31, 'Meadow', '67'),
    sew(228, 220, 121, 'Canary Yellow', '68'),
    sew(203, 138, 26, 'Toast', '69'),
    sew(198, 170, 66, 'Beige', '70'),
    sew(236, 176, 44, 'Honey Dew', '71'),
    sew(248, 128, 64, 'Tangerine', '72'),
    sew(255, 229, 5, 'Ocean Blue', '73'),
    sew(250, 122, 122, 'Sepia', '74'),
    sew(107, 224, 0, 'Royal Purple', '75'),
    sew(56, 108, 174, 'Yellow Ocher', '76'),
    sew(208, 186, 176, 'Beige Grey', '77'),
    sew(227, 190, 129, 'Bamboo', '78'),
  ];
}

// Distância de cor "red mean" (https://www.compuphase.com/cmetric.htm).
// redMean usa arredondamento par-mais-próximo (round() do Python), diferente
// do Math.round (que arredonda 0,5 sempre para cima).
function colorDistanceRedMean(r1, g1, b1, r2, g2, b2) {
  const sum = r1 + r2;
  const half = sum >> 1;
  const redMean = sum % 2 === 0 ? half : half % 2 === 0 ? half : half + 1;
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  return (((512 + redMean) * r * r) >> 8) + 4 * g * g + (((767 - redMean) * b * b) >> 8);
}

// findColor: Thread ou inteiro 0xRRGGBB. values: array com null nas entradas
// já consumidas/inexistentes (ignoradas). Em empate fica com o ÚLTIMO índice
// (mesmo critério do pystitch: comparação com <=).
function findNearestColorIndex(findColor, values) {
  const color = findColor && typeof findColor === 'object' ? findColor.color : findColor;
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  let closestIndex = null;
  let currentClosest = Infinity;
  for (let i = 0; i < values.length; i++) {
    const t = values[i];
    if (!t) continue;
    const dist = colorDistanceRedMean(red, green, blue, t.red(), t.green(), t.blue());
    if (dist <= currentClosest) {
      currentClosest = dist;
      closestIndex = i;
    }
  }
  return closestIndex;
}

// Mapeia cada fio do threadlist para um índice único dentro de threadPalette
// (casamento por cor mais próxima, sem repetir slot). Muta threadPalette
// (zera os slots já usados) — sempre passe uma paleta obtida na hora
// (getPecThreadSet()/getJefThreadSet() já retornam um array novo por chamada).
function buildUniquePalette(threadPalette, threadlist) {
  const chart = new Array(threadPalette.length).fill(null);
  const unique = [];
  for (const thread of threadlist) {
    if (!unique.some((u) => threadsEqual(u, thread))) unique.push(thread);
  }
  for (const thread of unique) {
    const index = findNearestColorIndex(thread, threadPalette);
    if (index === null) break; // sem slots livres na paleta
    threadPalette[index] = null;
    chart[index] = thread;
  }
  return threadlist.map((thread) => findNearestColorIndex(thread, chart));
}

module.exports = {
  getPecThreadSet,
  getJefThreadSet,
  getHusThreadSet,
  getSewThreadSet,
  findNearestColorIndex,
  buildUniquePalette,
};
