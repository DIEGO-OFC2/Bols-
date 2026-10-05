export const getBinaryNodeChildren = (node, childTag) => {
    if (!node || !Array.isArray(node.content))
        return [];
    const out = [];
    for (const child of node.content) {
        if (child.tag === childTag)
            out.push(child);
    }
    return out;
};
export const getBinaryNodeChild = (node, childTag) => getBinaryNodeChildren(node, childTag)[0];
export const getAllBinaryNodeChildren = (node) => Array.isArray(node.content) ? node.content : [];
export const getBinaryNodeChildBuffer = (node, childTag) => {
    const content = getBinaryNodeChild(node, childTag)?.content;
    return content instanceof Uint8Array ? content : undefined;
};
export const getBinaryNodeChildString = (node, childTag) => {
    const content = getBinaryNodeChild(node, childTag)?.content;
    if (content instanceof Uint8Array)
        return Buffer.from(content).toString('utf8');
    if (typeof content === 'string')
        return content;
    return undefined;
};
export const getBinaryNodeChildUInt = (node, childTag, length) => {
    const buf = getBinaryNodeChildBuffer(node, childTag);
    if (!buf)
        return undefined;
    let out = 0;
    for (let i = 0; i < length; i++)
        out = 256 * out + buf[i];
    return out;
};
//# sourceMappingURL=generic-utils.js.map