# Fontes de linha única (lettering, Fase 1)

Estas fontes alimentam a ferramenta de texto do Bastidor (issue #7, Fase 1):
cada glifo é um conjunto de traços abertos (centerline), prontos para virar
ponto corrido ou ponto triplo, sem precisar resolver o eixo médio de um
contorno preenchido.

## Origem

Todas as três fontes vêm do repositório **SVG Fonts**, mantido por
Dr. Windell H. Oskay (Evil Mad Scientist Laboratories / Bantam Tools):

> https://gitlab.com/oskay/svg-fonts

Nota: o roadmap desta issue citava `github.com/evil-mad/svg-fonts`, mas esse
repositório não existe mais nesse endereço; o acervo real está no GitLab
acima (também espelhado em `github.com/golanlevin/p5-single-line-font-resources`).
Confirmamos a licença de cada fonte direto no repositório antes de incluir
qualquer arquivo aqui.

## Fontes incluídas

| Arquivo | Fonte SVG | Estilo | Licença |
|---|---|---|---|
| `EMS/EMSNixish.svg` | EMS Nixish | sans-serif | SIL Open Font License 1.1 |
| `EMS/EMSAllure.svg` | EMS Allure | script/cursiva | SIL Open Font License 1.1 |
| `Hershey/HersheySans1.svg` | Hershey Sans 1-stroke | técnica/sans (1 traço) | Hershey Fonts (licença permissiva com atribuição) |

## Créditos

**EMS Nixish** e **EMS Allure** — Criadas por **Sheldon B. Michaels**;
conversão para SVG Font por **Windell H. Oskay** (Evil Mad Scientist).
Derivadas de fontes do Google Fonts sob SIL OFL:

- EMS Nixish ← *Nixie One*, de Jovanny Lemonad (http://jovanny.ru)
- EMS Allure ← *Allura*, de Rob Leuschke / TypeSETit (http://www.typesetit.com)

Licença completa em `EMS/LICENSE-OFL.txt` (SIL Open Font License, Version 1.1).

**Hershey Sans 1-stroke** — Traçado original de **Dr. A. V. Hershey**
(U.S. National Bureau of Standards); formato de dados originalmente por
James Hurt (Cognition, Inc.); preparada como fonte SVG em 2019 por
**Windell H. Oskay** (Evil Mad Scientist Laboratories). Licença/atribuição
completa em `Hershey/LICENSE.txt`.

## Formato

Todos os arquivos `.svg` seguem o formato **SVG 1.1 Font**
(`<font>` / `<font-face>` / `<glyph>` / `<missing-glyph>`), com
`units-per-em="1000"`, `ascent="800"`, `descent="-200"` e glifos desenhados
como traços abertos (comandos `M`/`L`/`C` no atributo `d`), com a coordenada Y
crescendo para cima — a conversão para o Y-para-baixo do Bastidor acontece em
`src/core/lettering/svgfont.js`.

## Licenciamento no Bastidor

Os três arquivos são livres para uso e redistribuição (com atribuição),
compatíveis com a licença MIT do restante do projeto. Ao empacotar o
Bastidor, os arquivos desta pasta devem ser distribuídos junto (ver
`fonts/EMS/LICENSE-OFL.txt` e `fonts/Hershey/LICENSE.txt`).
