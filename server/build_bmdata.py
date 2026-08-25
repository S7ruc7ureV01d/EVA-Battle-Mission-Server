#!/usr/bin/env python3
"""
Hand-builds a minimal legacy-format ("UnityWeb") Unity AssetBundle containing:
  1. An `AssetBundle` object (classID 142) at fileID=1 — the bundle
     "manifest": m_Container maps each TextAsset's lowercase name to it, and
     m_RuntimeCompatibility must be set correctly or the runtime rejects the
     whole bundle (see below).
  2. One `TextAsset` object (classID 49) per entry in `build_bmdata_bundle`'s
     `text_assets` dict (fileID 2, 3, 4, ...), each holding a JSON payload —
     `DownloadManager`/`AssetBundleResource` read these by name via
     `AssetBundle.Load(name)` (see build_bmdata_bundle()'s own comment for
     exactly which names are required and why).

Format derived from the REAL Unity 4.3.1 engine C++ source (see
/home/xh64bit/Projects/EvaBatMission/UnitySource — a leaked engine source
drop), specifically:
  - PlatformDependent/CommonWebPlugin/UnityWebStream.cpp: ParseStreamHeader()
    — the actual runtime bundle-envelope reader used by WWW.assetBundle.
  - Runtime/Serialize/SerializedFile.cpp: ReadMetadata(), kCurrentSerializeVersion.
  - Runtime/Misc/AssetBundleUtility.cpp: FindAssetBundleObject() (AssetBundle
    object MUST be at fileID 1 or 2, else a stub with
    m_RuntimeCompatibility=0 is used) and TestAssetBundleCompatibility()
    (rejects if m_RuntimeCompatibility < AssetBundle::CURRENT_RUNTIME_
    COMPATIBILITY_VERSION == 1) — this is what an earlier TextAsset-only
    build was missing, producing the on-device error "could not be loaded
    because it is not compatible with this newer version of the Unity
    runtime".
  - Runtime/Misc/AssetBundle.cpp/.h: AssetBundle::Transfer() field order,
    AssetInfo struct, CURRENT_RUNTIME_COMPATIBILITY_VERSION=1.
  - Runtime/BaseClasses/BaseObject.h: PPtr<T>::Transfer() (m_FileID then
    m_PathID, both SInt32 when LOCAL_IDENTIFIER_IN_FILE_SIZE==32).
  - Runtime/Serialize/TransferFunctions/SafeBinaryRead.h:
    TransferSTLStyleArray/Map() — [SInt32 count][elements...], map elements
    are (key, value) pairs in that order.
  - Runtime/Scripting/TextAsset.cpp / NamedObject.cpp: field transfer order.
  - AssetBundle::GetPathRange() lowercases the lookup key, so container
    keys must be stored lowercase ("bundledata", not "BundleData").

Big-endian throughout (Unity's historical on-disk convention, per
"SerializedFileHeader ... This header is always in BigEndian when in file").
"""

import json
import lzma
import os
import struct
import sys

# CONFIRMED (2026-08-25, via a real Wine-hosted Unity 4.1.3 Editor
# Android-target build, hand-parsed byte-for-byte — see info.md): a real
# Android-target bundle's metadata/object section is LITTLE-ENDIAN
# (m_Endianess=0), matching Android's native endianness. This used to hit
# a "Mismatched serialization... Read N-1 but expected N" error on
# device — root-caused and fixed (see build_asset_bundle_object()'s
# 3-byte-field comment below); little-endian is now the confirmed-working
# default. Set BMDATA_BIG_ENDIAN=1 to fall back to the old (also correct,
# but not what real bundles use) big-endian path.
ENDIAN = ">" if os.environ.get("BMDATA_BIG_ENDIAN") else "<"
FILE_ENDIANESS_BYTE = b"\x01" if os.environ.get("BMDATA_BIG_ENDIAN") else b"\x00"


def u32(v):
    return struct.pack(ENDIAN + "I", v)


def i32(v):
    return struct.pack(ENDIAN + "i", v)


def u16(v):
    return struct.pack(ENDIAN + "H", v)


def cstr(s):
    return s.encode("utf-8") + b"\x00"


def aligned_string(s):
    # UnityStr fields: int32 length prefix + raw bytes, padded to a 4-byte
    # boundary. Consistent across every source examined (UnityPy,
    # AssetStudio, and this engine source's transfer functions all agree).
    b = s.encode("utf-8")
    out = i32(len(b)) + b
    pad = (4 - len(out) % 4) % 4
    return out + b"\x00" * pad


def unity_lzma_compress(data: bytes) -> bytes:
    """Unity's classic LZMA container: 1-byte props + 4-byte dict_size +
    8-byte decompressed-size header, then a raw (headerless) LZMA1 stream.
    Shipped Unity asset bundles are LZMA-compressed ("UnityWeb" signature,
    isCompressed = (signature == "UnityWeb") per ParseStreamHeader).
    """
    dict_size = 0x800000  # 1 << 23
    compressor = lzma.LZMACompressor(
        format=lzma.FORMAT_RAW,
        filters=[{
            "id": lzma.FILTER_LZMA1,
            "dict_size": dict_size,
            "lc": 3,
            "lp": 0,
            "pb": 2,
            "mode": lzma.MODE_NORMAL,
            "mf": lzma.MF_BT4,
            "nice_len": 123,
        }],
    )
    compressed = compressor.compress(data) + compressor.flush()
    return struct.pack("<BIQ", 0x5D, dict_size, len(data)) + compressed


ASSET_BUNDLE_CLASS_ID = 142
TEXT_ASSET_CLASS_ID = 49
CURRENT_RUNTIME_COMPATIBILITY_VERSION = 1
SERIALIZED_FILE_VERSION = 9  # kCurrentSerializeVersion in the 4.3.1 source;
# 4.6.6f2 is only a few minor releases later so this format-version number
# should still be well within what it can read (readers stay backward
# compatible; a version *higher* than what the running engine understands
# is what gets silently rejected — see SerializedFile.cpp:
#   if (header.m_Version > kCurrentSerializeVersion) return false;


def _pptr(ptr_file_id, ptr_path_id):
    return i32(ptr_file_id) + i32(ptr_path_id)


def _asset_info(preload_index, preload_size, ptr_file_id, ptr_path_id):
    return i32(preload_index) + i32(preload_size) + _pptr(ptr_file_id, ptr_path_id)


def build_asset_bundle_object(entries: list) -> bytes:
    """entries: list of (container_key, target_file_id) pairs, one per
    TextAsset (or other object) the bundle should expose by name."""
    # NamedObject::m_Name (bundle's own name — irrelevant to lookup, empty is fine)
    out = aligned_string("")
    # SOLVED (2026-08-25, IL-patch + Wine Unity 4.1.3 Editor session — see
    # info.md's full writeup): this device's actual engine (4.6.6f2) has an
    # extra, unnamed 3-byte field in AssetBundle::Transfer() right after
    # NamedObject's m_Name and before m_PreloadTable, that doesn't exist in
    # the 4.3.1 engine source this file was originally derived from (some
    # field added to AssetBundle between 4.3.1 and 4.6.6f2 — exact identity
    # unknown, but zero-filled works fine and gets a byte-exact,
    # zero-error read on device, confirmed via the engine's own
    # "Mismatched serialization... Read N but expected M" diagnostic as an
    # exact oracle). Every earlier version of this file was missing these
    # 3 bytes, which under LITTLE-ENDIAN (see ENDIAN note above — the
    # correct encoding, confirmed against a real Editor-built bundle)
    # desynced every field read after it by 3 bytes, corrupting
    # m_RuntimeCompatibility's read and everything downstream. This is
    # what actually fixed the long-standing "Contains()/mainAsset always
    # null" bug — confirmed on-device: the client proceeds cleanly past
    # `AssetBundleResource.LoadResourceMap` with zero errors of any kind.
    out += b"\x00\x00\x00"
    # m_PreloadTable: vector<PPtr<Object>>.
    #
    # Also confirmed via the same real Wine-hosted Unity 4.1.3 Editor
    # Android-target build, hand-parsed byte-for-byte: a real bundle's
    # m_PreloadTable is NOT empty — it contains one PPtr entry per
    # referenced object, and each m_Container/m_MainAsset AssetInfo's
    # preloadIndex/preloadSize point INTO this table rather than being
    # left at (0,0). See AssetBundleUtility.cpp's ForcePreload(), which
    # walks exactly this table for exactly this reason. (On its own,
    # without the 3-byte fix above, this alone did NOT resolve the bug —
    # both were needed.)
    out += i32(len(entries))
    for _key, fid in entries:
        out += _pptr(0, fid)
    # m_Container: multimap<UnityStr, AssetInfo> — one entry per exposed
    # object, lowercase key (AssetBundle::GetPathRange lowercases the
    # lookup, so the stored key must already be lowercase to ever match).
    # preloadIndex/preloadSize point at this entry's own slot in
    # m_PreloadTable above (index i, size 1).
    out += i32(len(entries))
    for i, (key, fid) in enumerate(entries):
        out += aligned_string(key.lower())
        out += _asset_info(i, 1, 0, fid)
    # m_MainAsset: AssetInfo — none (no main asset in this bundle)
    out += _asset_info(0, 0, 0, 0)
    # m_ScriptCompatibility: vector<AssetBundleScriptInfo> — empty
    out += i32(0)
    # m_ClassCompatibility: vector<pair<int,UInt32>> — empty
    out += i32(0)
    # m_RuntimeCompatibility: UInt32 — MUST be >= CURRENT_RUNTIME_COMPATIBILITY_VERSION
    out += u32(CURRENT_RUNTIME_COMPATIBILITY_VERSION)
    return out


def build_text_asset_object(asset_name: str, script_text: str) -> bytes:
    # TextAsset::Transfer(): Super (NamedObject: m_Name) then m_Script then m_PathName.
    return aligned_string(asset_name) + aligned_string(script_text) + aligned_string("")


def build_serialized_file(text_assets: dict, unity_version="4.6.6f2") -> bytes:
    """text_assets: {asset_name: json_text}, one TextAsset per entry,
    all exposed by name from a single AssetBundle object at fileID=1."""
    ASSET_BUNDLE_FILE_ID = 1

    names = list(text_assets.keys())
    file_ids = {name: 2 + i for i, name in enumerate(names)}

    asset_bundle_data = build_asset_bundle_object([(name, file_ids[name]) for name in names])

    # Objects are laid out back-to-back in the data section, in file-ID
    # order. Object-to-object boundaries do NOT need to be 4-byte aligned
    # (only string/array *content* does, via explicit Align() calls inside
    # an object's own field reads) — confirmed by the AssetBundle object
    # now legitimately being 83 bytes (not a multiple of 4) after the
    # 3-byte-field fix above, with zero read errors on device.
    objects = [(ASSET_BUNDLE_FILE_ID, ASSET_BUNDLE_CLASS_ID, asset_bundle_data)]
    for name in names:
        objects.append((file_ids[name], TEXT_ASSET_CLASS_ID, build_text_asset_object(name, text_assets[name])))

    obj_data = b""
    byte_starts = []
    for _fid, _cid, data in objects:
        byte_starts.append(len(obj_data))
        obj_data += data

    # ---- SerializedFileHeader (20 bytes, always big-endian on disk) ----
    header_len = 20

    # ---- metadata section (SerializedFile::ReadMetadata, version=9) ----
    meta = b""

    # unityVersion string (version>=7). needsVersionCheck kicks in whenever
    # typeCount==0 (our case — no type tree, a stripped/player-safe build)
    # and requires EITHER an exact full-version string match, OR — if the
    # string contains a newline — that the part after it matches
    # kAssetBundleVersionNumber ("1" in this source; an asset-bundle-format
    # compatibility number distinct from the engine's dotted version, and
    # much less likely to have changed by 4.6.6f2). Use the newline form.
    meta += cstr(unity_version + "\n1")

    # m_TargetPlatform (version>=8): UInt32, enum BuildTargetPlatform.
    # kBuild_Android = 13 (SerializationMetaFlags.h).
    meta += u32(13)

    # typeCount (SInt32) = 0: no type tree section at all.
    meta += i32(0)

    # bigIDEnabled (SInt32, version>=7) = 0: object file IDs are 4 bytes.
    meta += i32(0)

    # objectCount, then one ObjectInfo entry per object:
    #   SInt32 fileID; SInt32 byteStart; SInt32 byteSize;
    #   SInt32 typeID; SInt16 classID;   UInt16 isDestroyed;
    # (byteStart is stored RELATIVE to dataOffset.)
    meta += i32(len(objects))
    for (fid, cid, data), start in zip(objects, byte_starts):
        meta += i32(fid)
        meta += i32(start)
        meta += i32(len(data))
        meta += i32(cid)  # typeID
        meta += u16(cid)  # classID
        meta += u16(0)  # isDestroyed

    # externalsCount (SInt32) = 0
    meta += i32(0)

    # userInformation string (version>=5) — empty.
    meta += cstr("")

    data_offset = header_len + len(meta)
    data_pad = (4 - data_offset % 4) % 4
    meta += b"\x00" * data_pad
    data_offset += data_pad

    file_size = data_offset + len(obj_data)
    metadata_size = len(meta)

    # SerializedFileHeader's own 4 leading ints are ALWAYS big-endian on
    # disk (ReadHeader byte-swaps this raw struct read based on the host's
    # own endianness, independent of m_Endianess) — do not use the
    # ENDIAN-controlled u32() here.
    bu32 = lambda v: struct.pack(">I", v)
    header = bu32(metadata_size) + bu32(file_size) + bu32(SERIALIZED_FILE_VERSION) + bu32(data_offset)
    header += FILE_ENDIANESS_BYTE
    header += b"\x00\x00\x00"  # m_Reserved
    assert len(header) == header_len

    out = header + meta + obj_data
    assert len(out) == file_size, (len(out), file_size)
    return out


def build_bundle(cab_name: str, serialized_file_bytes: bytes,
                  unity_version="4.6.6f2") -> bytes:
    # The directory table (like the outer "UnityWeb" stream header below,
    # and the SerializedFileHeader) is UNCONDITIONALLY big-endian —
    # confirmed against the real Wine-built reference bundle, which parsed
    # cleanly only when this table was read as big-endian regardless of the
    # inner SerializedFile's own m_Endianess byte. Do not use the
    # ENDIAN-controlled u32()/i32() here.
    bu32 = lambda v: struct.pack(">I", v)
    bi32 = lambda v: struct.pack(">i", v)

    # ---- inner "uncompressed blob": directory table + file content ----
    # node.offset is relative to the start of this blob, i.e. it must point
    # PAST the directory table itself, to where the file content starts.
    node_content_offset = 4 + len(cstr(cab_name)) + 4 + 4  # nodesCount + path + offset + size
    directory = bi32(1)  # nodesCount
    directory += cstr(cab_name)  # path
    directory += bu32(node_content_offset)  # offset of node content, relative to blob start
    directory += bu32(len(serialized_file_bytes))  # size
    assert len(directory) == node_content_offset

    blob = directory + serialized_file_bytes
    compressed_blob = unity_lzma_compress(blob)

    # ---- outer "UnityWeb" header, per UnityWebStream.cpp ParseStreamHeader:
    #   string  signature ("UnityWeb" -> isCompressed=true)
    #   UInt32  streamVersion
    #   string  unityVersion
    #   string  unityRevision
    #   UInt32  minimumStreamedBytes
    #   UInt32  headerSize
    #   UInt32  numberOfLevelsToDownloadBeforeStreaming
    #   UInt32  levelCount, then `levelCount` x (UInt32 compressedEnd, UInt32 decompressedEnd)
    #   UInt32  completeFileSize      (streamVersion >= 2)
    #   UInt32  fileInfoHeaderSize    (streamVersion >= 3)
    # No hash/crc fields exist anywhere in this reader, at any version —
    # that was an incorrect assumption carried over from reverse-engineered
    # tools (UnityPy/AssetStudio) calibrated against later Unity releases.
    prefix = b""
    prefix += cstr("UnityWeb")
    prefix += bu32(3)  # streamVersion
    prefix += cstr(unity_version)  # unityVersion
    prefix += cstr(unity_version)  # unityRevision
    prefix += bu32(0)  # minimumStreamedBytes
    # headerSize field itself comes next, computed below
    tail = b""
    tail += bu32(1)  # numberOfLevelsToDownloadBeforeStreaming
    tail += bu32(1)  # levelCount = 1 -> exactly one (compressedEnd, decompressedEnd) pair
    tail += bu32(len(compressed_blob))  # compressedEnd
    tail += bu32(len(blob))  # decompressedEnd
    tail += bu32(0)  # completeFileSize placeholder, patched below (streamVersion>=2)
    tail += bu32(0)  # fileInfoHeaderSize, unused by the reader (streamVersion>=3)

    header_size = len(prefix) + 4 + len(tail)  # +4 for the headerSize field itself
    full_header = prefix + bu32(header_size) + tail
    assert len(full_header) == header_size, (len(full_header), header_size)

    complete_file_size = header_size + len(compressed_blob)
    # patch completeFileSize back in (it's the 3rd-to-last u32 in `tail`)
    full_header = bytearray(full_header)
    patch_off = len(prefix) + 4 + 4 + 4 + 4 + 4  # after headerSize,numLevels,levelCount,compEnd,decompEnd
    full_header[patch_off:patch_off + 4] = bu32(complete_file_size)
    full_header = bytes(full_header)

    out = full_header + compressed_blob
    assert len(out) == complete_file_size, (len(out), complete_file_size)
    return out


# SOLVED (2026-08-25, same Wine/IL-patch session, continued): with an
# EMPTY BundleData list, AssetBundleResource.assetBundles is an empty
# (non-null, so GetProgress() doesn't hit its null-check) list, and
# DownloadManager.ProgressOfBundles() explicitly returns 0.0 (not 1.0 or
# NaN) whenever its total weight is zero — see the disassembled
# ProgressOfBundles IL: `brtrue`s past a `ldc.r4 0.; ret` only when the
# weight local is nonzero. TitleController.DownloadAssetBundle() then
# spins forever in a `while (progress.GetProgress() < 1) yield return
# null;`-style loop with NO further network activity and NO crash —
# exactly the "alive but stuck on the loading screen" symptom this
# session hit. Fix: BundleData needs at least one real entry, AND
# BundleBuildState needs a matching entry (DownloadManager.download()
# does `buildStatesDict[name]` — a raw dictionary indexer, not
# TryGetValue — so a BundleData entry with no matching BuildStates
# entry throws KeyNotFoundException instead of just failing silently),
# AND the server needs to actually serve `<name>.assetBundle` (any
# valid empty AssetBundle works — see server.js's handleDummyBundle()).
DUMMY_BUNDLE_NAME = "dummy"


def build_bmdata_bundle(bundle_data_json: str = None) -> bytes:
    # DownloadManager.Start() (see info.md) expects THREE named TextAssets
    # out of this exact same bundle (it re-downloads "BMData" a second time
    # via WWW.LoadFromCacheOrDownload and reads all three from it):
    #   "BundleData"  -> List<BundleData>      (what AssetBundleResource reads)
    #   "BuildStates" -> List<BundleBuildState> (must have a matching entry
    #                     for every BundleData entry — see DUMMY_BUNDLE_NAME
    #                     comment above)
    #   "BMConfiger"  -> BMConfiger             ({} is fine — its .ctor sets
    #                     sane defaults (compress=true, useCache=true, etc.)
    #                     and LitJson only overrides fields present in the JSON)
    if bundle_data_json is None:
        bundle_data_json = json.dumps([{"name": DUMMY_BUNDLE_NAME}])
    build_states_json = json.dumps([{
        "bundleName": DUMMY_BUNDLE_NAME, "version": 1, "crc": 0,
        "size": 138, "changeTime": 0, "lastBuildDependencies": [],
    }])
    text_assets = {
        "BundleData": bundle_data_json,
        "BuildStates": build_states_json,
        "BMConfiger": "{}",
    }
    sf = build_serialized_file(text_assets)
    return build_bundle("CAB-bmdata0000000000000000000000", sf)


def build_empty_bundle(cab_name: str) -> bytes:
    """A minimal, valid, content-free AssetBundle — used for the "dummy"
    downloadable bundle BundleData points at (see DUMMY_BUNDLE_NAME)."""
    sf = build_serialized_file({})
    return build_bundle(cab_name, sf)


if __name__ == "__main__":
    json_payload = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else "BMData.bundle"
    data = build_bmdata_bundle(json_payload)
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"wrote {len(data)} bytes to {out_path}")

    dummy_path = os.path.join(os.path.dirname(out_path) or ".", f"{DUMMY_BUNDLE_NAME}.assetBundle")
    dummy_data = build_empty_bundle(f"CAB-{DUMMY_BUNDLE_NAME}00000000000000000000000"[:33])
    with open(dummy_path, "wb") as f:
        f.write(dummy_data)
    print(f"wrote {len(dummy_data)} bytes to {dummy_path}")
