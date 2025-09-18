import { promises as fs } from 'fs';

export interface MeetingItem {
  agenda: string;
  notes: string;
}

export interface MeetingRecord {
  meeting_id: string;
  timestamp: string;
  salt?: string;
  items: MeetingItem[];
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function ensureObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalizeString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${path} must be a string`);
  }
  // Normalize all newline variants to \n for deterministic hashing.
  return value.replace(/\r\n?/g, '\n');
}

function canonicalizeOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return canonicalizeString(value, path);
}

function validateTimestamp(value: string, path: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${path} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function parseMeetingRecord(data: unknown): MeetingRecord {
  const meeting = ensureObject(data, 'Meeting record');
  const meetingId = canonicalizeString(meeting['meeting_id'], 'meeting_id');
  const timestamp = validateTimestamp(
    canonicalizeString(meeting['timestamp'], 'timestamp'),
    'timestamp',
  );
  const salt = canonicalizeOptionalString(meeting['salt'], 'salt');

  const itemsValue = meeting['items'];
  if (!Array.isArray(itemsValue)) {
    throw new ValidationError('items must be an array');
  }
  if (itemsValue.length === 0) {
    throw new ValidationError('items must contain at least one entry');
  }

  const items: MeetingItem[] = itemsValue.map((entry, index) => {
    const item = ensureObject(entry, `items[${index}]`);
    return {
      agenda: canonicalizeString(item['agenda'], `items[${index}].agenda`),
      notes: canonicalizeString(item['notes'], `items[${index}].notes`),
    };
  });

  return {
    meeting_id: meetingId,
    timestamp,
    salt,
    items,
  };
}

export async function loadMeetingRecord(filePath: string): Promise<MeetingRecord> {
  const raw = await fs.readFile(filePath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`Failed to parse JSON: ${(error as Error).message}`);
  }
  return parseMeetingRecord(json);
}

export { ValidationError };
