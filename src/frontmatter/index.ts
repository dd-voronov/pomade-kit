// pomade-kit/frontmatter — field-only frontmatter writes: change one field, leave every other
// byte unchanged. Pure; runs in Node and in the browser.

export { getBody, removeField, setBody, setField, setKeyLines, splitFrontmatter, type FieldValue, type FieldWriteError, type FieldWriteResult } from "./file.js";
export {
  addProperty,
  emitScalar,
  getKeyLines,
  moveKey,
  parseFrontmatter,
  removeProperty,
  setBooleanValue,
  setComplexKeyLines,
  setListValue,
  setScalarValue,
  validateYaml,
  type ParsedFrontmatter,
  type PropRow,
  type PropType,
} from "./block.js";
