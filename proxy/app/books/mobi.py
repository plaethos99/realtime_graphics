"""Minimal reader for DRM-free Kindle files: MOBI, PRC, AZW, AZW3 (KF8) and AZW4 (print replica).

Returns the book's HTML (text records decompressed and joined) plus title and author. Images and the
KF8 skeleton/fragment tables are ignored: stripping tags from the joined records is enough for reading.
"""
from __future__ import annotations

import re
import struct
from dataclasses import dataclass


class MobiError(Exception):
    pass


@dataclass
class MobiBook:
    html: str
    title: str
    author: str
    pdf: bytes | None = None  # AZW4 wraps a PDF


def _records(data: bytes) -> list[bytes]:
    count = struct.unpack_from(">H", data, 76)[0]
    offsets = [struct.unpack_from(">L", data, 78 + i * 8)[0] for i in range(count)]
    offsets.append(len(data))
    return [data[offsets[i] : offsets[i + 1]] for i in range(count)]


_LITERALS = re.compile(rb"[\x00\x09-\x7f]+")


def _palmdoc(data: bytes) -> bytes:
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        run = _LITERALS.match(data, i)  # most bytes are plain ASCII: copy them a run at a time
        if run:
            out += run.group()
            i = run.end()
            continue
        c = data[i]
        i += 1
        if 1 <= c <= 8:
            out += data[i : i + c]
            i += c
        elif c < 0x80:
            out.append(c)
        elif c >= 0xC0:
            out.append(0x20)
            out.append(c ^ 0x80)
        else:
            if i >= n:
                break
            pair = (c << 8) | data[i]
            i += 1
            dist = (pair >> 3) & 0x7FF
            length = (pair & 7) + 3
            if dist == 0 or dist > len(out):
                continue
            start = len(out) - dist
            if dist >= length:
                out += out[start : start + length]
            else:  # the copy overlaps what it is writing
                for k in range(length):
                    out.append(out[start + k])
    return bytes(out)


class _Huffcdic:
    """HUFF/CDIC decompression used by many Amazon-made MOBI files."""

    def __init__(self, huff: bytes, cdics: list[bytes]):
        if huff[:8] != b"HUFF\x00\x00\x00\x18":
            raise MobiError("Bad HUFF record")
        off1, off2 = struct.unpack_from(">LL", huff, 8)

        def dict1_entry(v: int) -> tuple[int, int, int]:
            codelen, term, maxcode = v & 0x1F, v & 0x80, v >> 8
            return codelen, term, ((maxcode + 1) << (32 - codelen)) - 1

        self.dict1 = [dict1_entry(v) for v in struct.unpack_from(">256L", huff, off1)]
        dict2 = struct.unpack_from(">64L", huff, off2)
        self.mincode = [0] + [m << (32 - i) for i, m in enumerate(dict2[0::2], start=1)]
        self.maxcode = [0] + [((m + 1) << (32 - i)) - 1 for i, m in enumerate(dict2[1::2], start=1)]
        self.dictionary: list[tuple[bytes, int] | None] = []
        for cdic in cdics:
            if cdic[:8] != b"CDIC\x00\x00\x00\x10":
                raise MobiError("Bad CDIC record")
            phrases, bits = struct.unpack_from(">LL", cdic, 8)
            n = min(1 << bits, phrases - len(self.dictionary))
            for off in struct.unpack_from(f">{n}H", cdic, 16):
                (blen,) = struct.unpack_from(">H", cdic, 16 + off)
                self.dictionary.append((cdic[18 + off : 18 + off + (blen & 0x7FFF)], blen & 0x8000))

    def unpack(self, data: bytes) -> bytes:
        bitsleft = len(data) * 8
        data += b"\x00" * 8
        pos = 0
        (x,) = struct.unpack_from(">Q", data, pos)
        n = 32
        out = bytearray()
        while True:
            if n <= 0:
                pos += 4
                (x,) = struct.unpack_from(">Q", data, pos)
                n += 32
            code = (x >> n) & 0xFFFFFFFF
            codelen, term, maxcode = self.dict1[code >> 24]
            if not term:
                while code < self.mincode[codelen]:
                    codelen += 1
                maxcode = self.maxcode[codelen]
            n -= codelen
            bitsleft -= codelen
            if bitsleft < 0:
                break
            r = (maxcode - code) >> (32 - codelen)
            entry = self.dictionary[r]
            if entry is None:
                raise MobiError("Corrupt HUFF data")
            phrase, done = entry
            if not done:
                self.dictionary[r] = None  # guards against loops while expanding
                phrase = self.unpack(phrase)
                self.dictionary[r] = (phrase, 1)
            out += phrase
        return bytes(out)


def _trailing_size(record: bytes, flags: int) -> int:
    """Bytes of per-record trailing data to strip before decompressing."""

    def entry_size(end: int) -> int:
        result, bitpos = 0, 0
        while end > 0:
            v = record[end - 1]
            result |= (v & 0x7F) << bitpos
            bitpos += 7
            end -= 1
            if v & 0x80 or bitpos >= 28:
                break
        return result

    size = 0
    test = flags >> 1
    while test:
        if test & 1:
            size += entry_size(len(record) - size)
        test >>= 1
    if flags & 1:
        size += (record[len(record) - size - 1] & 0x3) + 1
    return size


def read_mobi(data: bytes) -> MobiBook:
    if len(data) < 78 or data[60:68] not in (b"BOOKMOBI", b"TEXtREAd"):
        raise MobiError("Not a MOBI/AZW file")
    records = _records(data)
    rec0 = records[0]
    compression, _, text_length, text_records, _, encryption = struct.unpack_from(">HHLHHH", rec0, 0)
    if encryption != 0:
        raise MobiError(
            "This Kindle book is DRM-protected, so it can't be read. Only DRM-free books work "
            "(for example from Project Gutenberg, Standard Ebooks, or books you made yourself)."
        )

    title = data[:32].split(b"\x00")[0].decode("latin-1").replace("_", " ")
    author = ""
    encoding = "cp1252"
    extra_flags = 0
    huff = None
    if rec0[16:20] == b"MOBI":
        header_len, _, text_encoding = struct.unpack_from(">LLL", rec0, 20)
        encoding = "utf-8" if text_encoding == 65001 else "cp1252"
        name_off, name_len = struct.unpack_from(">LL", rec0, 84)
        if name_len and name_off + name_len <= len(rec0):
            title = rec0[name_off : name_off + name_len].decode(encoding, "replace")
        if header_len >= 0xE4 and len(rec0) >= 0xF4:
            extra_flags = struct.unpack_from(">H", rec0, 0xF2)[0]
        if compression == 17480:
            huff_off, huff_count = struct.unpack_from(">LL", rec0, 112)
            huff = _Huffcdic(records[huff_off], records[huff_off + 1 : huff_off + huff_count])
        exth_flags = struct.unpack_from(">L", rec0, 128)[0]
        exth = 16 + header_len
        if exth_flags & 0x40 and rec0[exth : exth + 4] == b"EXTH":
            count = struct.unpack_from(">L", rec0, exth + 8)[0]
            pos = exth + 12
            for _ in range(count):
                rtype, rlen = struct.unpack_from(">LL", rec0, pos)
                value = rec0[pos + 8 : pos + rlen].decode(encoding, "replace").strip()
                if rtype == 100 and not author:
                    author = value
                elif rtype == 503 and value:
                    title = value
                pos += rlen
    elif compression == 17480:
        raise MobiError("Unsupported MOBI compression")

    # AZW4 / print replica: the book is a PDF stored in one of the records.
    for rec in records[1:]:
        start = rec.find(b"%PDF", 0, 64)
        if start != -1 and len(rec) > 1024:
            return MobiBook(html="", title=title, author=author, pdf=rec[start:])

    parts: list[bytes] = []
    for rec in records[1 : 1 + text_records]:
        if extra_flags:
            rec = rec[: len(rec) - _trailing_size(rec, extra_flags)]
        if compression == 2:
            parts.append(_palmdoc(rec))
        elif compression == 17480 and huff:
            parts.append(huff.unpack(rec))
        else:
            parts.append(rec)
    raw = b"".join(parts)[: text_length or None]
    return MobiBook(html=raw.decode(encoding, "replace"), title=title.strip(), author=author)
