import assert from 'node:assert/strict';
import SwaggerParser from '@apidevtools/swagger-parser';
import { fileURLToPath } from 'node:url';

const spec = await SwaggerParser.validate(fileURLToPath(new URL('../openapi/auth.openapi.json', import.meta.url)));
assert.equal(spec.openapi, '3.1.1');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const operations = Object.values(spec.paths).flatMap(path => Object.entries(path).filter(([method]) => methods.has(method)).map(([, operation]) => operation));
assert.equal(operations.length, 33);
assert.equal(new Set(operations.map(operation => operation.operationId)).size, operations.length);
console.log('OpenAPI validated: 33 unique operations.');
