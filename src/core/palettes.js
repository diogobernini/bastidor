'use strict';
// Tabelas de fios de fábrica, portadas de pystitch (MIT, inkstitch/pystitch):
// EmbThreadPec.py (Brother) e EmbThreadJef.py (Janome).
// O índice 0 é null em ambas (marcador de "sem fio"/parada).
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

module.exports = { getPecThreadSet, getJefThreadSet, findNearestColorIndex, buildUniquePalette };
