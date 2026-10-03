// js/rbxm.js

"use strict";

/*
 * Binary RBXM reader
 *
 * Пока наша задача:
 *  - прочитать Binary .rbxm;
 *  - восстановить Instance tree;
 *  - прочитать основные свойства;
 *  - нормально прочитать KeyframeSequence / Keyframe / Pose;
 *  - прочитать CFrame;
 *
 * На данном этапе мы НЕ занимаемся:
 *  - MeshPart / MeshId;
 *  - Accessories;
 *  - Hair;
 *  - Clothing;
 *  - Part geometry;
 *  - JJS conversion.
 */

const RBXM = (() => {

    // =========================================================
    // Reader
    // =========================================================

    class Reader {
        constructor(buffer) {
            this.buffer = buffer instanceof ArrayBuffer
                ? buffer
                : buffer.buffer.slice(
                    buffer.byteOffset,
                    buffer.byteOffset + buffer.byteLength
                );

            this.bytes = new Uint8Array(this.buffer);
            this.view = new DataView(this.buffer);
            this.offset = 0;
        }

        get remaining() {
            return this.bytes.length - this.offset;
        }

        ensure(size) {
            if (this.offset + size > this.bytes.length) {
                throw new Error(
                    `Unexpected end of data at 0x${this.offset.toString(16)}`
                );
            }
        }

        u8() {
            this.ensure(1);
            return this.bytes[this.offset++];
        }

        i8() {
            this.ensure(1);
            return this.view.getInt8(this.offset++);
        }

        u16le() {
            this.ensure(2);
            const value = this.view.getUint16(this.offset, true);
            this.offset += 2;
            return value;
        }

        u32le() {
            this.ensure(4);
            const value = this.view.getUint32(this.offset, true);
            this.offset += 4;
            return value;
        }

        i32le() {
            this.ensure(4);
            const value = this.view.getInt32(this.offset, true);
            this.offset += 4;
            return value;
        }

        i32be() {
            this.ensure(4);
            const value = this.view.getInt32(this.offset, false);
            this.offset += 4;
            return value;
        }

        u32be() {
            this.ensure(4);
            const value = this.view.getUint32(this.offset, false);
            this.offset += 4;
            return value;
        }

        f32le() {
            this.ensure(4);
            const value = this.view.getFloat32(this.offset, true);
            this.offset += 4;
            return value;
        }

        f32be() {
            this.ensure(4);
            const value = this.view.getFloat32(this.offset, false);
            this.offset += 4;
            return value;
        }

        f64le() {
            this.ensure(8);
            const value = this.view.getFloat64(this.offset, true);
            this.offset += 8;
            return value;
        }

        bytesSlice(length) {
            this.ensure(length);

            const result = this.bytes.slice(
                this.offset,
                this.offset + length
            );

            this.offset += length;

            return result;
        }

        stringFixed(length) {
            return new TextDecoder("utf-8").decode(
                this.bytesSlice(length)
            );
        }

        string() {
            const length = this.u32le();

            if (length > this.remaining) {
                throw new Error(
                    `Invalid string length ${length}`
                );
            }

            return this.stringFixed(length);
        }

        subReader(length) {
            const data = this.bytesSlice(length);
            return new Reader(data.buffer);
        }
    }


    // =========================================================
    // Binary helpers
    // =========================================================

    function equalBytes(a, b) {
        if (a.length !== b.length) {
            return false;
        }

        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }

        return true;
    }


    function readInterleavedBytes(reader, count, width) {
        const result = new Uint8Array(count * width);

        for (let byteIndex = 0; byteIndex < width; byteIndex++) {
            for (let itemIndex = 0; itemIndex < count; itemIndex++) {
                result[itemIndex * width + byteIndex] = reader.u8();
            }
        }

        return result;
    }


    function readRobloxFloatFromBytes(bytes, offset) {
        /*
         * Roblox float format:
         *
         * eeeeeeee mmmmmmmm mmmmmmmm mmmmmmms
         *
         * Unlike normal IEEE float:
         * the sign bit is the LAST bit.
         */

        const b0 = bytes[offset];
        const b1 = bytes[offset + 1];
        const b2 = bytes[offset + 2];
        const b3 = bytes[offset + 3];

        const exponent =
            ((b0 << 1) | (b1 >> 7)) & 0xff;

        const mantissa =
            ((b1 & 0x7f) << 16) |
            (b2 << 8) |
            (b3 & 0xfe) |
            ((b3 & 0x01) ? 0 : 0);

        const sign = b3 & 1;

        // Special values
        if (exponent === 0xff) {
            if (mantissa === 0) {
                return sign ? -Infinity : Infinity;
            }

            return NaN;
        }

        let value;

        if (exponent === 0) {
            if (mantissa === 0) {
                value = 0;
            } else {
                value =
                    (mantissa / 0x800000) *
                    Math.pow(2, -126);
            }
        } else {
            value =
                (1 + mantissa / 0x800000) *
                Math.pow(2, exponent - 127);
        }

        return sign ? -value : value;
    }


    function readRobloxFloatArray(reader, count) {
        const raw = readInterleavedBytes(reader, count, 4);
        const result = new Array(count);

        for (let i = 0; i < count; i++) {
            result[i] = readRobloxFloatFromBytes(raw, i * 4);
        }

        return result;
    }


    function untransformInt32(value) {
        // Zig-zag inverse.
        //
        // Encoded:
        // positive x -> 2*x
        // negative x -> 2*abs(x)-1
        //
        // Decode:
        // even -> x / 2
        // odd  -> -(x + 1) / 2

        const unsigned = value >>> 0;

        if ((unsigned & 1) === 0) {
            return unsigned / 2;
        }

        return -((unsigned + 1) / 2);
    }


    function readInt32Array(reader, count) {
        const raw = readInterleavedBytes(reader, count, 4);
        const values = new Array(count);

        for (let i = 0; i < count; i++) {
            const offset = i * 4;

            const encoded =
                ((raw[offset] << 24) |
                 (raw[offset + 1] << 16) |
                 (raw[offset + 2] << 8) |
                 raw[offset + 3]) >>> 0;

            values[i] = untransformInt32(encoded);
        }

        return values;
    }


    function readReferentArray(reader, count) {
        const deltas = readInt32Array(reader, count);

        const result = new Array(count);

        let previous = 0;

        for (let i = 0; i < count; i++) {
            previous += deltas[i];
            result[i] = previous;
        }

        return result;
    }


    // =========================================================
    // LZ4 block decompressor
    // =========================================================

    function lz4Decompress(input, expectedSize) {
        const output = new Uint8Array(expectedSize);

        let ip = 0;
        let op = 0;

        while (ip < input.length) {

            const token = input[ip++];

            let literalLength = token >> 4;

            if (literalLength === 15) {
                let byte;

                do {
                    if (ip >= input.length) {
                        throw new Error("Invalid LZ4 literal length");
                    }

                    byte = input[ip++];
                    literalLength += byte;
                } while (byte === 255);
            }

            if (ip + literalLength > input.length) {
                throw new Error("Invalid LZ4 literal data");
            }

            if (op + literalLength > output.length) {
                throw new Error("LZ4 output overflow");
            }

            output.set(
                input.subarray(ip, ip + literalLength),
                op
            );

            ip += literalLength;
            op += literalLength;

            // Last sequence has no match.
            if (ip >= input.length) {
                break;
            }

            if (ip + 2 > input.length) {
                throw new Error("Invalid LZ4 match offset");
            }

            const matchOffset =
                input[ip] |
                (input[ip + 1] << 8);

            ip += 2;

            if (matchOffset === 0 || matchOffset > op) {
                throw new Error("Invalid LZ4 match offset");
            }

            let matchLength = token & 0x0f;

            if (matchLength === 15) {
                let byte;

                do {
                    if (ip >= input.length) {
                        throw new Error("Invalid LZ4 match length");
                    }

                    byte = input[ip++];
                    matchLength += byte;
                } while (byte === 255);
            }

            matchLength += 4;

            if (op + matchLength > output.length) {
                throw new Error("LZ4 output overflow");
            }

            for (let i = 0; i < matchLength; i++) {
                output[op + i] =
                    output[op - matchOffset + i];

                // Important:
                // this allows overlapping copies.
            }

            op += matchLength;
        }

        if (op !== expectedSize) {
            throw new Error(
                `LZ4 size mismatch: expected ${expectedSize}, got ${op}`
            );
        }

        return output;
    }


    // =========================================================
    // Chunk decompression
    // =========================================================

    function readChunk(reader) {
        const nameBytes = reader.bytesSlice(4);

        const name =
            String.fromCharCode(...nameBytes);

        const compressedLength = reader.u32le();
        const uncompressedLength = reader.u32le();

        // Reserved.
        reader.u32le();

        if (compressedLength === 0) {
            return {
                name,
                data: reader.bytesSlice(uncompressedLength)
            };
        }

        const compressed =
            reader.bytesSlice(compressedLength);

        // ZSTD magic:
        // 28 B5 2F FD
        if (
            compressed.length >= 4 &&
            compressed[0] === 0x28 &&
            compressed[1] === 0xb5 &&
            compressed[2] === 0x2f &&
            compressed[3] === 0xfd
        ) {
            throw new Error(
                "Этот RBXM использует Zstandard (ZSTD). " +
                "В текущем браузерном декодере ZSTD пока не подключён."
            );
        }

        return {
            name,
            data: lz4Decompress(
                compressed,
                uncompressedLength
            )
        };
    }


    // =========================================================
    // Property values
    // =========================================================

    function readStringArray(reader, count) {
        const values = [];

        for (let i = 0; i < count; i++) {
            values.push(reader.string());
        }

        return values;
    }


    function readBoolArray(reader, count) {
        const values = [];

        for (let i = 0; i < count; i++) {
            values.push(reader.u8() !== 0);
        }

        return values;
    }


    function readFloat64Array(reader, count) {
        const values = [];

        for (let i = 0; i < count; i++) {
            values.push(reader.f64le());
        }

        return values;
    }


    function readEnumArray(reader, count) {
        const raw =
            readInterleavedBytes(reader, count, 4);

        const values = [];

        for (let i = 0; i < count; i++) {
            const o = i * 4;

            const value =
                ((raw[o] << 24) |
                 (raw[o + 1] << 16) |
                 (raw[o + 2] << 8) |
                 raw[o + 3]) >>> 0;

            values.push(value);
        }

        return values;
    }


    function readVector3Array(reader, count) {
        const x = readRobloxFloatArray(reader, count);
        const y = readRobloxFloatArray(reader, count);
        const z = readRobloxFloatArray(reader, count);

        const values = [];

        for (let i = 0; i < count; i++) {
            values.push({
                x: x[i],
                y: y[i],
                z: z[i]
            });
        }

        return values;
    }


    function readCFrameArray(reader, count) {
        const ids = [];

        const matrices = new Array(count).fill(null);

        const SPECIAL_ROTATIONS = {
            0x02: [0, 0, 0],
            0x03: [90, 0, 0],
            0x05: [0, 180, 180],
            0x06: [-90, 0, 0],
            0x07: [0, 180, 90],
            0x09: [0, 90, 90],
            0x0a: [0, 0, 90],
            0x0c: [0, -90, 90],
            0x0d: [-90, -90, 0],
            0x0e: [0, -90, 0],
            0x10: [90, -90, 0],
            0x11: [0, 90, 180],

            0x14: [0, 180, 0],
            0x15: [-90, -180, 0],
            0x17: [0, 0, 180],
            0x18: [90, 180, 0],
            0x19: [0, 0, -90],
            0x1b: [0, -90, -90],
            0x1c: [0, -180, -90],
            0x1e: [0, 90, -90],
            0x1f: [90, 90, 0],
            0x20: [0, 90, 0],
            0x22: [-90, 90, 0],
            0x23: [0, -90, 180]
        };

        for (let i = 0; i < count; i++) {
            const id = reader.u8();

            ids.push(id);

            if (id === 0) {
                const raw =
                    reader.bytesSlice(9 * 4);

                const matrix = [];

                for (let j = 0; j < 9; j++) {
                    const o = j * 4;

                    const bytes = raw.subarray(o, o + 4);

                    const temp =
                        new Uint8Array(bytes).buffer;

                    const view =
                        new DataView(temp);

                    matrix.push(
                        view.getFloat32(0, true)
                    );
                }

                matrices[i] = matrix;
            } else {
                if (!SPECIAL_ROTATIONS[id]) {
                    throw new Error(
                        `Unknown CFrame rotation ID: 0x${id.toString(16)}`
                    );
                }

                matrices[i] =
                    SPECIAL_ROTATIONS[id];
            }
        }

        // Position is stored AFTER all orientations.
        const positions =
            readVector3Array(reader, count);

        const result = [];

        for (let i = 0; i < count; i++) {
            result.push({
                position: positions[i],
                rotation: matrices[i],
                rotationId: ids[i]
            });
        }

        return result;
    }


    function readPropertyValues(reader, typeId, count) {

        switch (typeId) {

            // String
            case 0x01:
                return readStringArray(reader, count);

            // Bool
            case 0x02:
                return readBoolArray(reader, count);

            // Int32
            case 0x03:
                return readInt32Array(reader, count);

            // Float32
            case 0x04:
                return readRobloxFloatArray(reader, count);

            // Float64
            case 0x05:
                return readFloat64Array(reader, count);

            // Vector2
            case 0x0d: {
                const x =
                    readRobloxFloatArray(reader, count);

                const y =
                    readRobloxFloatArray(reader, count);

                return x.map((_, i) => ({
                    x: x[i],
                    y: y[i]
                }));
            }

            // Vector3
            case 0x0e:
                return readVector3Array(reader, count);

            // CFrame
            case 0x10:
                return readCFrameArray(reader, count);

            // Enum
            case 0x12:
                return readEnumArray(reader, count);

            // Referent
            case 0x13:
                return readReferentArray(reader, count);

            // Vector3int16
            case 0x14: {
                const result = [];

                for (let i = 0; i < count; i++) {
                    result.push({
                        x: reader.view.getInt16(reader.offset, true),
                        y: reader.view.getInt16(reader.offset + 2, true),
                        z: reader.view.getInt16(reader.offset + 4, true)
                    });

                    reader.offset += 6;
                }

                return result;
            }

            // NumberRange
            case 0x17: {
                const result = [];

                for (let i = 0; i < count; i++) {
                    result.push({
                        min: reader.f32le(),
                        max: reader.f32le()
                    });
                }

                return result;
            }

            // Color3uint8
            case 0x1a: {
                const r = [];
                const g = [];
                const b = [];

                for (let i = 0; i < count; i++) {
                    r.push(reader.u8());
                }

                for (let i = 0; i < count; i++) {
                    g.push(reader.u8());
                }

                for (let i = 0; i < count; i++) {
                    b.push(reader.u8());
                }

                return r.map((_, i) => ({
                    r: r[i],
                    g: g[i],
                    b: b[i]
                }));
            }

            // SharedString
            case 0x1c:
                return readEnumArray(reader, count);

            // Bytecode
            case 0x1d:
                return readStringArray(reader, count);

            default:
                throw new Error(
                    `Unsupported RBXM property type: 0x${typeId.toString(16)}`
                );
        }
    }


    // =========================================================
    // Chunk parsing
    // =========================================================

    function parseINST(data) {
        const reader = new Reader(data.buffer);

        const classId = reader.u32le();
        const className = reader.string();

        const objectFormat = reader.u8();

        const count = reader.u32le();

        const referents =
            readReferentArray(reader, count);

        // Service marker array.
        let serviceMarkers = null;

        if (objectFormat === 1) {
            serviceMarkers = [];

            for (let i = 0; i < count; i++) {
                serviceMarkers.push(reader.u8());
            }
        }

        return {
            classId,
            className,
            objectFormat,
            count,
            referents,
            serviceMarkers
        };
    }


    function parsePROP(data, instancesByClassId) {
        const reader = new Reader(data.buffer);

        const classId = reader.u32le();

        const propertyName = reader.string();

        const typeId = reader.u8();

        const classInfo =
            instancesByClassId.get(classId);

        if (!classInfo) {
            throw new Error(
                `PROP references unknown class ID ${classId}`
            );
        }

        const values =
            readPropertyValues(
                reader,
                typeId,
                classInfo.referents.length
            );

        return {
            classId,
            propertyName,
            typeId,
            values
        };
    }


    function parsePRNT(data) {
        const reader = new Reader(data.buffer);

        const version = reader.u8();

        if (version !== 0) {
            throw new Error(
                `Unsupported PRNT version: ${version}`
            );
        }

        const count = reader.u32le();

        const children =
            readReferentArray(reader, count);

        const parents =
            readReferentArray(reader, count);

        return {
            version,
            count,
            children,
            parents
        };
    }


    function parseMETA(data) {
        const reader = new Reader(data.buffer);

        const count = reader.u32le();

        const metadata = {};

        for (let i = 0; i < count; i++) {
            const key = reader.string();
            const value = reader.string();

            metadata[key] = value;
        }

        return metadata;
    }


    // =========================================================
    // Main decoder
    // =========================================================

    function parse(arrayBuffer) {

        const reader =
            new Reader(arrayBuffer);

        // -----------------------------------------------------
        // Header
        // -----------------------------------------------------

        const magic =
            reader.stringFixed(8);

        if (magic !== "<roblox!") {
            throw new Error(
                "Файл не является Binary RBXM: неверный magic."
            );
        }

        const signature =
            Array.from(reader.bytesSlice(6));

        const expectedSignature = [
            0x89,
            0xff,
            0x0d,
            0x0a,
            0x1a,
            0x0a
        ];

        if (!equalBytes(signature, expectedSignature)) {
            throw new Error(
                "Неверная сигнатура Binary RBXM."
            );
        }

        const version =
            reader.u16le();

        if (version !== 0) {
            throw new Error(
                `Неподдерживаемая версия RBXM: ${version}`
            );
        }

        const classCount =
            reader.i32le();

        const instanceCount =
            reader.i32le();

        // Reserved 8 bytes.
        reader.bytesSlice(8);

        const chunks = [];

        const classes =
            new Map();

        const properties = [];

        let parents = null;
        let metadata = {};

        // -----------------------------------------------------
        // Chunks
        // -----------------------------------------------------

        while (reader.remaining > 0) {

            const chunk =
                readChunk(reader);

            chunks.push(chunk);

            switch (chunk.name) {

                case "META":
                    metadata =
                        parseMETA(chunk.data);

                    break;

                case "INST": {
                    const inst =
                        parseINST(chunk.data);

                    if (classes.has(inst.classId)) {
                        throw new Error(
                            `Duplicate INST class ID: ${inst.classId}`
                        );
                    }

                    classes.set(
                        inst.classId,
                        inst
                    );

                    break;
                }

                case "PROP":
                    properties.push(chunk.data);
                    break;

                case "PRNT":
                    parents =
                        parsePRNT(chunk.data);

                    break;

                case "END\0": {
                    const endReader =
                        new Reader(chunk.data.buffer);

                    const end =
                        endReader.stringFixed(
                            Math.min(9, chunk.data.length)
                        );

                    if (end !== "</roblox>") {
                        throw new Error(
                            "Неверный END chunk RBXM."
                        );
                    }

                    break;
                }

                case "SSTR":
                    // SharedString пока не нужен
                    // для нашего animation MVP.
                    break;

                default:
                    console.warn(
                        "Unknown RBXM chunk:",
                        chunk.name
                    );
            }

            if (chunk.name === "END\0") {
                break;
            }
        }

        if (!parents) {
            throw new Error(
                "RBXM не содержит PRNT chunk."
            );
        }

        // -----------------------------------------------------
        // Create instances
        // -----------------------------------------------------

        const instances =
            new Map();

        for (const instInfo of classes.values()) {

            for (let i = 0; i < instInfo.referents.length; i++) {

                const referent =
                    instInfo.referents[i];

                instances.set(
                    referent,
                    {
                        referent,
                        className: instInfo.className,
                        name: instInfo.className,

                        parent: null,
                        children: [],

                        properties: {}
                    }
                );
            }
        }

        // -----------------------------------------------------
        // Properties
        // -----------------------------------------------------

        for (const propData of properties) {

            const prop =
                parsePROP(
                    propData,
                    classes
                );

            const classInfo =
                classes.get(prop.classId);

            for (let i = 0; i < classInfo.referents.length; i++) {

                const referent =
                    classInfo.referents[i];

                const instance =
                    instances.get(referent);

                if (!instance) {
                    continue;
                }

                instance.properties[
                    prop.propertyName
                ] = prop.values[i];

                // Roblox Name property.
                if (prop.propertyName === "Name") {
                    instance.name =
                        String(prop.values[i]);
                }
            }
        }

        // -----------------------------------------------------
        // Parent hierarchy
        // -----------------------------------------------------

        for (let i = 0; i < parents.children.length; i++) {

            const childRef =
                parents.children[i];

            const parentRef =
                parents.parents[i];

            const child =
                instances.get(childRef);

            if (!child) {
                continue;
            }

            if (parentRef === -1) {
                child.parent = null;
                continue;
            }

            const parent =
                instances.get(parentRef);

            if (!parent) {
                continue;
            }

            child.parent = parent;
            parent.children.push(child);
        }

        // -----------------------------------------------------
        // Roots
        // -----------------------------------------------------

        const roots = [];

        for (const instance of instances.values()) {
            if (instance.parent === null) {
                roots.push(instance);
            }
        }

        return {
            header: {
                version,
                classCount,
                instanceCount
            },

            metadata,

            classes,

            instances,

            roots,

            chunks
        };
    }


    // =========================================================
    // Utility functions for converter
    // =========================================================

    function findAll(root, predicate) {

        const result = [];

        function visit(node) {

            if (predicate(node)) {
                result.push(node);
            }

            for (const child of node.children) {
                visit(child);
            }
        }

        visit(root);

        return result;
    }


    function findByClass(root, className) {
        return findAll(
            root,
            node => node.className === className
        );
    }


    function findByName(root, name) {
        return findAll(
            root,
            node => node.name === name
        );
    }


    function getProperty(instance, propertyName, fallback = null) {
        if (!instance) {
            return fallback;
        }

        if (
            Object.prototype.hasOwnProperty.call(
                instance.properties,
                propertyName
            )
        ) {
            return instance.properties[propertyName];
        }

        return fallback;
    }


    function printTree(root, indent = "") {

        console.log(
            `${indent}${root.className}: ${root.name}`
        );

        for (const child of root.children) {
            printTree(child, indent + "  ");
        }
    }


    // =========================================================
    // Animation extraction
    // =========================================================

    function extractAnimation(root) {

        const result = {
            keyframeSequences: []
        };

        const sequences =
            findAll(
                root,
                node =>
                    node.className === "KeyframeSequence"
            );

        for (const sequence of sequences) {

            const animation = {
                name: sequence.name,
                priority: getProperty(
                    sequence,
                    "Priority"
                ),
                keyframes: []
            };

            const keyframes =
                sequence.children.filter(
                    child =>
                        child.className === "Keyframe"
                );

            keyframes.sort(
                (a, b) =>
                    Number(
                        getProperty(a, "Time", 0)
                    ) -
                    Number(
                        getProperty(b, "Time", 0)
                    )
            );

            for (const keyframe of keyframes) {

                const frame = {
                    time: Number(
                        getProperty(
                            keyframe,
                            "Time",
                            0
                        )
                    ),

                    poses: []
                };

                const poses =
                    findAll(
                        keyframe,
                        node =>
                            node.className === "Pose"
                    );

                for (const pose of poses) {

                    frame.poses.push({
                        name: pose.name,

                        cframe: getProperty(
                            pose,
                            "CFrame"
                        ),

                        easingStyle:
                            getProperty(
                                pose,
                                "EasingStyle"
                            ),

                        easingDirection:
                            getProperty(
                                pose,
                                "EasingDirection"
                            ),

                        weight:
                            getProperty(
                                pose,
                                "Weight"
                            ),

                        maskWeight:
                            getProperty(
                                pose,
                                "MaskWeight"
                            )
                    });
                }

                animation.keyframes.push(frame);
            }

            result.keyframeSequences.push(
                animation
            );
        }

        return result;
    }


    // =========================================================
    // Public API
    // =========================================================

    return {
        parse,

        findAll,
        findByClass,
        findByName,

        getProperty,

        printTree,

        extractAnimation
    };

})();


// Global browser API.
window.RBXM = RBXM;