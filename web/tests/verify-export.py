# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf==7.1.1"]
# ///
"""Inspect real downloads. Signatures or file size alone do not prove rendering."""

import argparse
from xml.etree import ElementTree
from zipfile import ZipFile

from pypdf import PdfReader


def docx(path):
    with ZipFile(path) as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        assert any(name.startswith("word/media/") for name in archive.namelist())
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    heading_styles = []
    for paragraph in document.findall(".//w:p", ns):
        style = paragraph.find("w:pPr/w:pStyle", ns)
        if style is not None:
            heading_styles.append(style.get(f"{{{ns['w']}}}val"))
    for style in ("Heading1", "Heading2"):
        assert style in heading_styles, heading_styles
    assert document.find(".//w:numPr", ns) is not None, "No Word list"
    assert document.find(".//w:tbl", ns) is not None, "No Word table"
    assert document.find(".//w:drawing", ns) is not None, "No embedded drawing"
    assert document.find(".//{http://schemas.openxmlformats.org/officeDocument/2006/math}oMath") is not None, "No Word equation"


def pdf(path, control):
    def outline(items):
        return [outline(item) if isinstance(item, list) else item.title for item in items]

    def painted_paths(document):
        return sum(
            operator in (b"f", b"f*", b"B", b"B*", b"S", b"s")
            for page in document.pages
            for _, operator in page.get_contents().operations
        )

    document = PdfReader(path)
    baseline = PdfReader(control)
    book = outline(document.outline)
    assert book == ["Parent Chapter", ["Child Chapter"]], book
    text = " ".join(" ".join(page.extract_text().split()) for page in document.pages)
    for phrase in ("Parent Chapter", "Child Chapter", "TableValue", "DiagramAnchor"):
        assert phrase in text, (phrase, text)
    assert "flowchart TD" not in text and "x^2" not in text, text
    assert any(page.images for page in document.pages), "No embedded attachment in PDF"
    assert painted_paths(document) > painted_paths(baseline), "The equation did not add vector drawing operations"


parser = argparse.ArgumentParser(description=__doc__)
sub = parser.add_subparsers(required=True)
word = sub.add_parser("docx")
word.add_argument("path")
word.set_defaults(verify=docx)
portable = sub.add_parser("pdf")
portable.add_argument("path")
portable.add_argument("control")
portable.set_defaults(verify=pdf)
args = vars(parser.parse_args())
args.pop("verify")(**args)
