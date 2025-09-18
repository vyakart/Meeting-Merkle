import { createHash } from 'crypto';
import type { MeetingItem, MeetingRecord } from './io';

export interface MerkleTree {
  root: string;
  layers: string[][];
  leaves: string[];
}

export type MerklePosition = 'left' | 'right';

export interface MerkleProofNode {
  position: MerklePosition;
  hash: string;
}

export interface MembershipProof {
  index: number;
  leaf: string;
  proof: MerkleProofNode[];
  root: string;
}

class MerkleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerkleError';
  }
}

function hashUtf8(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hashLeaf(item: MeetingItem, salt?: string): Buffer {
  const payload = salt ? `${salt}\n${item.agenda}\n${item.notes}` : `${item.agenda}\n${item.notes}`;
  return hashUtf8(payload);
}

export function computeLeafHash(item: MeetingItem, salt?: string): string {
  return hashLeaf(item, salt).toString('hex');
}

function hashInternal(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([left, right])).digest();
}

function buildTreeBuffers(items: MeetingItem[], salt?: string): Buffer[][] {
  if (items.length === 0) {
    throw new MerkleError('Cannot build Merkle tree with no items');
  }

  let currentLevel = items.map((item) => hashLeaf(item, salt));
  const levels: Buffer[][] = [currentLevel];

  while (currentLevel.length > 1) {
    const nextLevel: Buffer[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] ?? currentLevel[i];
      nextLevel.push(hashInternal(left, right));
    }
    currentLevel = nextLevel;
    levels.push(currentLevel);
  }

  return levels;
}

function buffersToHex(levels: Buffer[][]): string[][] {
  return levels.map((level) => level.map((node) => node.toString('hex')));
}

function toHex(buffer: Buffer): string {
  return buffer.toString('hex');
}

export function buildMerkleTree(items: MeetingItem[], salt?: string): MerkleTree {
  const levels = buildTreeBuffers(items, salt);
  return {
    root: toHex(levels[levels.length - 1][0]),
    layers: buffersToHex(levels),
    leaves: buffersToHex([levels[0]])[0],
  };
}

function generateProofFromLevels(levels: Buffer[][], index: number): MerkleProofNode[] {
  if (index < 0 || index >= levels[0].length) {
    throw new MerkleError(`Leaf index ${index} is out of bounds`);
  }

  const proof: MerkleProofNode[] = [];
  let currentIndex = index;

  for (let level = 0; level < levels.length - 1; level += 1) {
    const currentLevel = levels[level];
    const isRightNode = currentIndex % 2 === 1;
    const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
    const sibling = currentLevel[siblingIndex] ?? currentLevel[currentIndex];

    proof.push({
      position: isRightNode ? 'left' : 'right',
      hash: sibling.toString('hex'),
    });

    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

export function generateMembershipProof(
  items: MeetingItem[],
  index: number,
  salt?: string,
): MembershipProof {
  const levels = buildTreeBuffers(items, salt);
  const proof = generateProofFromLevels(levels, index);
  const leaf = levels[0][index]?.toString('hex');

  if (!leaf) {
    throw new MerkleError(`Unable to locate leaf at index ${index}`);
  }

  return {
    index,
    leaf,
    proof,
    root: levels[levels.length - 1][0].toString('hex'),
  };
}

function bufferFromHexOrThrow(value: string, context: string): Buffer {
  if (!/^([0-9a-f]{2})+$/i.test(value) || value.length !== 64) {
    throw new MerkleError(`${context} must be a 32-byte hex string`);
  }
  return Buffer.from(value, 'hex');
}

export function verifyProof(leaf: string, proof: MerkleProofNode[], expectedRoot: string): boolean {
  let computed = bufferFromHexOrThrow(leaf, 'leaf');
  const rootBuffer = bufferFromHexOrThrow(expectedRoot, 'expected root');

  for (const step of proof) {
    const sibling = bufferFromHexOrThrow(step.hash, 'proof hash');
    computed = step.position === 'left'
      ? hashInternal(sibling, computed)
      : hashInternal(computed, sibling);
  }

  return computed.equals(rootBuffer);
}

export function computeRootForMeeting(meeting: MeetingRecord): string {
  return buildMerkleTree(meeting.items, meeting.salt).root;
}

export function verifyMeeting(meeting: MeetingRecord, expectedRoot: string): boolean {
  try {
    const normalized = bufferFromHexOrThrow(expectedRoot, 'expected root').toString('hex');
    const actualRoot = computeRootForMeeting(meeting);
    return actualRoot === normalized;
  } catch (error) {
    if (error instanceof MerkleError) {
      return false;
    }
    throw error;
  }
}

export { MerkleError };
