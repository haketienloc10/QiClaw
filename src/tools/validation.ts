import type { JsonSchema, Tool } from './tool.js';

export function validateToolInput(tool: Tool, input: unknown): void {
  validateJsonSchemaObject(tool.inputSchema, input, `tool ${tool.name} input`);
}

function validateJsonSchemaObject(schema: JsonSchema, input: unknown, label: string): void {
  if (!isPlainObject(input)) {
    throw new Error(`Invalid input for ${label}: expected an object.`);
  }

  const inputObject = input as Record<string, unknown>;
  const required = new Set(schema.required ?? []);

  for (const key of required) {
    if (!(key in inputObject)) {
      throw new Error(`Invalid input for ${label}: missing required property \"${key}\".`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(inputObject)) {
      if (!(key in schema.properties)) {
        throw new Error(`Invalid input for ${label}: unexpected property \"${key}\".`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!(key in inputObject)) {
      continue;
    }

    validatePropertyValue(propertySchema, inputObject[key], `${label}.${key}`);
  }
}

function validatePropertyValue(schema: unknown, value: unknown, label: string): void {
  if (!schema || typeof schema !== 'object' || !('type' in schema)) {
    return;
  }

  const schemaRecord = schema as {
    type?: unknown;
    items?: unknown;
  };

  if (schemaRecord.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`Invalid input for ${label}: expected a string.`);
    }

    return;
  }

  if (schemaRecord.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Invalid input for ${label}: expected a number.`);
    }

    return;
  }

  if (schemaRecord.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid input for ${label}: expected a boolean.`);
    }

    return;
  }

  if (schemaRecord.type === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid input for ${label}: expected an array.`);
    }

    for (const item of value) {
      validatePropertyValue(schemaRecord.items, item, `${label}[]`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
