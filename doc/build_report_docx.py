"""
Builds 'Báo cáo hoàn thiện IoT nhóm 1.docx' from BAO_CAO_HOAN_THIEN_IOT_NHOM_1.md.

The two cover pages (main cover with the HUIT logo and the inner cover) of the existing Word
file are kept; everything after them is regenerated from the Markdown report with the group's
formatting: Times New Roman, black text, 13 pt body justified with a 0.8 cm first-line indent
and 1.3 line spacing, 16 pt chapter headings, grid tables, centred figures with captions.

Usage (from the repository root):   python doc/build_report_docx.py
Optional: --out <path> to write somewhere else instead of replacing the Word file.
"""
import argparse
import os
import re

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
MD_PATH = os.path.join(HERE, 'BAO_CAO_HOAN_THIEN_IOT_NHOM_1.md')
DOCX_PATH = os.path.join(HERE, 'Báo cáo hoàn thiện IoT nhóm 1.docx')
FONT = 'Times New Roman'
MONO = 'Consolas'
BLACK = RGBColor(0, 0, 0)
TEXT_WIDTH_CM = 16.0  # A4 21 cm minus 3 cm left and 2 cm right margins
FIRST_BODY_HEADING = 'BẢNG PHÂN CÔNG CÔNG VIỆC'  # first element after the two cover pages


# ----------------------------------------------------------------------------- inline text
def latex_to_text(expr):
    """The report uses a few simple LaTeX snippets ($40\\text{ cm}$, $\\pm 0.5^\\circ\\text{C}$)."""
    expr = re.sub(r'\\text\{([^}]*)\}', r'\1', expr)
    for src, dst in ((r'\times', '×'), (r'^\circ', '°'), (r'\circ', '°'), (r'\pm', '±'),
                     (r'\rightarrow', '→'), (r'\ge', '≥'), (r'\le', '≤'), (r'\%', '%')):
        expr = expr.replace(src, dst)
    return re.sub(r'\s+', ' ', expr).strip()


def clean_inline(text):
    text = re.sub(r'\$([^$]+)\$', lambda m: latex_to_text(m.group(1)), text)
    text = re.sub(r'\[([^\]]+)\]\(#[^)]*\)', r'\1', text)  # internal anchors -> plain text
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1 (\2)', text)
    return text.replace('\\"', '"')


TOKEN = re.compile(r'(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)')


def add_runs(paragraph, text, size=13, bold=None, italic=None, color=BLACK):
    """Adds Markdown-formatted text (**bold**, *italic*, `code`) as runs."""
    for part in TOKEN.split(clean_inline(text)):
        if not part:
            continue
        b, i, mono = bold, italic, False
        if part.startswith('**') and part.endswith('**') and len(part) > 4:
            part, b = part[2:-2], True
        elif part.startswith('`') and part.endswith('`') and len(part) > 2:
            part, mono = part[1:-1], True
        elif part.startswith('*') and part.endswith('*') and len(part) > 2:
            part, i = part[1:-1], True
        # Bold/italic markers nested inside the other kind (e.g. **"*text*"**).
        for sub in TOKEN.split(part) if ('*' in part or '`' in part) else [part]:
            if not sub:
                continue
            sb, si, sm = b, i, mono
            if sub.startswith('**') and sub.endswith('**') and len(sub) > 4:
                sub, sb = sub[2:-2], True
            elif sub.startswith('*') and sub.endswith('*') and len(sub) > 2:
                sub, si = sub[1:-1], True
            elif sub.startswith('`') and sub.endswith('`') and len(sub) > 2:
                sub, sm = sub[1:-1], True
            run = paragraph.add_run(sub)
            set_font(run, MONO if sm else FONT, size - (1 if sm else 0), sb, si, color)
    return paragraph


def set_font(run, name, size, bold=None, italic=None, color=BLACK):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn('w:rFonts'))
    if fonts is None:
        fonts = OxmlElement('w:rFonts')
        rpr.insert(0, fonts)
    for attr in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
        fonts.set(qn(attr), name)
    run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    run.font.color.rgb = color


# ----------------------------------------------------------------------------- blocks
class Builder:
    def __init__(self, doc):
        self.doc = doc
        self.front_matter = True  # "##" headings before the first chapter are page-level titles
        self.compact = False  # table of contents: tighter lines so it fits on one page

    def para(self, style=None):
        p = self.doc.add_paragraph(style=style)
        p.paragraph_format.line_spacing = 1.1 if self.compact else 1.3
        return p

    def page_break(self):
        p = self.doc.add_paragraph()
        p.add_run().add_break(WD_BREAK.PAGE)

    def heading(self, text, level, new_page=True):
        text = clean_inline(text).replace('**', '')
        self.compact = text == 'MỤC LỤC'
        if level == 1:
            if new_page:
                self.page_break()
            p = self.doc.add_paragraph(style='Heading 1')
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            size, before, after = 16, 6, 12
        elif level == 2:
            p = self.doc.add_paragraph(style='Heading 2')
            size, before, after = 14, 12, 6
        else:
            p = self.doc.add_paragraph(style='Heading 3')
            size, before, after = 13, 10, 4
        no_numbering(p)
        pf = p.paragraph_format
        pf.space_before, pf.space_after, pf.keep_with_next = Pt(before), Pt(after), True
        run = p.add_run(text)
        set_font(run, FONT, size, True, False)

    def body(self, text):
        p = self.para()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        pf = p.paragraph_format
        pf.first_line_indent, pf.space_after = Cm(0.8), Pt(4)
        add_runs(p, text)

    def bullet(self, text, depth):
        p = self.para(style='List Bullet')
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT if '`' in text else WD_ALIGN_PARAGRAPH.JUSTIFY
        pf = p.paragraph_format
        pf.space_after = Pt(0 if self.compact else 3)
        if depth:  # the style's own indent (bullet, gap, text) is kept for the first level
            pf.left_indent = Cm(1.27 + 0.75 * depth)
        add_runs(p, text)

    def numbered(self, number, text, depth):
        p = self.para()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT if '`' in text else WD_ALIGN_PARAGRAPH.JUSTIFY
        pf = p.paragraph_format
        pf.space_after = Pt(0 if self.compact else 3)
        pf.left_indent = Cm(0.95 + 0.75 * depth)
        pf.first_line_indent = Cm(-0.6)
        add_runs(p, f'{number}. {text}')

    def code(self, lines):
        for line in lines:
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.space_after, pf.space_before, pf.line_spacing = Pt(0), Pt(0), 1.0
            pf.left_indent = Cm(0.5)
            shade(p._p.get_or_add_pPr(), 'F2F2F2')
            run = p.add_run(line if line else ' ')
            set_font(run, MONO, 9.5)

    def image(self, alt, path):
        full = os.path.join(HERE, path)
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.keep_with_next = True
        p.add_run().add_picture(full, width=Cm(TEXT_WIDTH_CM))
        cap = self.doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.paragraph_format.space_after = Pt(8)
        add_runs(cap, alt, size=12, italic=True)

    def table(self, rows):
        cols = max(len(r) for r in rows)
        rows = [r + [''] * (cols - len(r)) for r in rows]
        table = self.doc.add_table(rows=len(rows), cols=cols)
        table.style = 'Table Grid'
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        # Column widths in proportion to their longest line, with a floor so short columns stay legible.
        # Each column is at least as wide as its longest word (no word broken in two); the rest
        # of the width is shared in proportion to the length of the column's text.
        def words(text):
            return re.sub(r'[*`]', '', clean_inline(text)).split()
        small = cols >= 5
        cm_per_char = 0.025 * (10.5 if small else 11.5)  # Times New Roman, generous for wide letters
        floors, weights = [], []
        for c in range(cols):
            longest_word = max((len(w) for row in rows for x in row[c].split('<br>') for w in words(x)), default=3)
            longest_line = max((len(clean_inline(x)) for row in rows for x in row[c].split('<br>')), default=3)
            floors.append(min(cm_per_char * longest_word + 0.45, 6.0))
            weights.append(min(max(longest_line, 4), 60))
        spare = max(0.0, TEXT_WIDTH_CM - sum(floors))
        widths = [f + spare * w / sum(weights) for f, w in zip(floors, weights)]
        scale = TEXT_WIDTH_CM / sum(widths)
        widths = [w * scale for w in widths]
        # Word follows the table grid, not only the cell widths: fix both and turn autofit off.
        table.autofit = False
        grid = table._tbl.tblGrid
        for c, col in enumerate(grid.findall(qn('w:gridCol'))):
            col.set(qn('w:w'), str(int(widths[c] / 2.54 * 1440)))
        tbl_pr = table._tbl.tblPr
        layout = OxmlElement('w:tblLayout')
        layout.set(qn('w:type'), 'fixed')
        tbl_pr.append(layout)
        for r, row in enumerate(rows):
            for c, cell_text in enumerate(row):
                cell = table.cell(r, c)
                cell.width = Cm(widths[c])
                cell.paragraphs[0].text = ''
                for k, piece in enumerate(cell_text.split('<br>')):
                    p = cell.paragraphs[0] if k == 0 else cell.add_paragraph()
                    p.paragraph_format.space_after = Pt(1)
                    p.paragraph_format.line_spacing = 1.1
                    if r == 0:
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    add_runs(p, piece.strip(), size=10.5 if small else 11.5, bold=True if r == 0 else None)
                if r == 0:
                    shade(cell._tc.get_or_add_tcPr(), 'D9D9D9')
        # A row is never split across two pages.
        for row in table.rows:
            cant = OxmlElement('w:cantSplit')
            cant.set(qn('w:val'), 'true')
            row._tr.get_or_add_trPr().append(cant)
        # Header row repeats on every page.
        tr_pr = table.rows[0]._tr.get_or_add_trPr()
        header = OxmlElement('w:tblHeader')
        header.set(qn('w:val'), 'true')
        tr_pr.append(header)
        spacer = self.doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(4)


def no_numbering(paragraph):
    """The template's heading styles number themselves ("CHƯƠNG N."); the report text already does."""
    ppr = paragraph._p.get_or_add_pPr()
    num = OxmlElement('w:numPr')
    for tag in ('w:ilvl', 'w:numId'):
        el = OxmlElement(tag)
        el.set(qn('w:val'), '0')
        num.append(el)
    ppr.append(num)


def shade(props, fill):
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill)
    props.append(shd)


# ----------------------------------------------------------------------------- document
def keep_covers(doc):
    """Removes everything after the two cover pages, keeping the final section properties."""
    body = doc.element.body
    start = None
    for el in body.iterchildren():
        if el.tag == qn('w:p') and FIRST_BODY_HEADING in ''.join(t.text or '' for t in el.iter(qn('w:t'))):
            start = el
            break
    if start is None:
        raise SystemExit(f'Could not find "{FIRST_BODY_HEADING}" after the cover pages.')
    remove, found = [], False
    for el in body.iterchildren():
        if el is start:
            found = True
        if found and el.tag != qn('w:sectPr'):
            remove.append(el)
    for el in remove:
        body.remove(el)


def update_covers(doc):
    """The covers said ĐỀ CƯƠNG (outline); this file is the final report."""
    for p in doc.paragraphs:
        for run in p.runs:
            if run.text.strip() == 'ĐỀ CƯƠNG IOT':
                run.text = run.text.replace('ĐỀ CƯƠNG IOT', 'BÁO CÁO ĐỒ ÁN IOT')
            if 'tháng 10' in run.text:
                run.text = run.text.replace('tháng 10', 'tháng 11')
        if p.text.replace(' ', '').startswith('TP.HồChíMinh,tháng') and '10' in p.text and 'tháng 11' not in p.text:
            for run in p.runs:
                run.text = run.text.replace('10', '11')


def build(md_text, doc):
    b = Builder(doc)
    lines = md_text.splitlines()
    # Skip the Markdown cover (title block); the Word covers are kept as they are.
    i = next(k for k, line in enumerate(lines) if line.startswith('## ') and FIRST_BODY_HEADING in line)
    paragraph = []

    def flush():
        if paragraph:
            b.body(' '.join(s.strip() for s in paragraph))
            paragraph.clear()

    first_heading = True
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith('```'):
            flush()
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                block.append(lines[i].rstrip())
                i += 1
            b.code(block)
        elif stripped.startswith('|'):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{2,}:?', c) for c in cells if c):
                    rows.append(cells)
                i += 1
            b.table(rows)
            continue
        elif stripped == '---' or not stripped:
            flush()
        elif m := re.match(r'^(#{1,3})\s+(.*)$', stripped):
            flush()
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                b.front_matter = False
                b.heading(text, 1)
            elif level == 2 and b.front_matter:
                if first_heading:
                    # Right after the covers: a page break already ends the inner cover.
                    p = doc.add_paragraph(style='Heading 1')
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    p.paragraph_format.space_after = Pt(12)
                    no_numbering(p)
                    set_font(p.add_run(clean_inline(text)), FONT, 16, True, False)
                    first_heading = False
                else:
                    # The three lists (figures, tables, abbreviations) share pages.
                    b.heading(text, 1, new_page=not text.startswith(('DANH MỤC BẢNG', 'DANH MỤC TỪ')))
            else:
                b.heading(text, level)
        elif m := re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', stripped):
            flush()
            b.image(m.group(1), m.group(2))
        elif m := re.match(r'^(\s*)[-*]\s+(.*)$', line):
            flush()
            b.bullet(m.group(2), len(m.group(1)) // 2)
        elif m := re.match(r'^(\s*)(\d+)\.\s+(.*)$', line):
            flush()
            b.numbered(m.group(2), m.group(3), len(m.group(1)) // 3)
        else:
            paragraph.append(stripped)
        i += 1
    flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=DOCX_PATH)
    parser.add_argument('--template', default=DOCX_PATH)
    args = parser.parse_args()
    doc = Document(args.template)
    keep_covers(doc)
    update_covers(doc)
    with open(MD_PATH, encoding='utf-8') as f:
        build(f.read(), doc)
    doc.save(args.out)
    print('Saved', args.out.encode('ascii', 'replace').decode())


if __name__ == '__main__':
    main()
