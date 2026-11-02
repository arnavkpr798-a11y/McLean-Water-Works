import { XMLParser } from 'fast-xml-parser';

const ARRAY_TAGS = new Set([
  'preset',
  'sourceItem',
  'member',
  'recent',
  'component',
  'capability',
  'error',
  'item',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  attributesGroupName: '$',
  textNodeName: '_text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Parse an XML document into plain objects; attributes live under `$`. */
export function parseXml(text) {
  if (!text || !String(text).trim()) return {};
  return parser.parse(String(text));
}

/** Text content of a parsed node (works for plain strings and attributed nodes). */
export function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object' && node._text != null) return String(node._text);
  return '';
}

export function attr(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  return node.$?.[name];
}

export function bool(value) {
  return String(value).trim().toLowerCase() === 'true';
}

export function num(value, fallback = null) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** First key of a parsed document (its root element name). */
export function rootName(doc) {
  return Object.keys(doc || {}).find((k) => k !== '?xml') || '';
}
