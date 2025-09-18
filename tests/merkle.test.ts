import { describe, expect, test } from 'vitest';
import {
  buildMerkleTree,
  computeLeafHash,
  computeRootForMeeting,
  generateMembershipProof,
  verifyMeeting,
  verifyProof,
} from '../src/merkle';
import { parseMeetingRecord } from '../src/io';

const sampleMeeting = parseMeetingRecord({
  meeting_id: 'Team-Weekly-2025-09-18',
  timestamp: '2025-09-18T10:00:00Z',
  salt: 'optional-random-string',
  items: [
    {
      agenda: 'Budget Allocation for Q4',
      notes: 'Allocate 500 tokens to community fund.',
    },
    {
      agenda: 'Project X Update',
      notes: 'Extend deadline to Nov 30.',
    },
    {
      agenda: 'Onboarding',
      notes: 'No formal resolution.',
    },
  ],
});

describe('Merkle tree', () => {
  test('computes deterministic root for sample meeting', () => {
    const tree = buildMerkleTree(sampleMeeting.items, sampleMeeting.salt);
    expect(tree.root).toBe('7a1ea358a7cf2b135d76c558f74ea39b1bfa37377d6a916d7a94fdfb8dfd0738');
    expect(tree.leaves).toEqual([
      '742bafad6709b8e599774a9118f8b04bd1e3c59f03ac6d98fab4d4fb120cb730',
      '862e3245309e18a41e87b5b9bc6f3d9831897158ab7f0b5f68ee518f97d49d5e',
      'e5dbfb38654dbb384479061240b8dcf751b36b09ccf51363eb32318d491b632f',
    ]);
  });

  test('generates proofs that round-trip for each item', () => {
    const tree = buildMerkleTree(sampleMeeting.items, sampleMeeting.salt);
    sampleMeeting.items.forEach((_item, index) => {
      const proof = generateMembershipProof(sampleMeeting.items, index, sampleMeeting.salt);
      expect(proof.root).toBe(tree.root);
      expect(verifyProof(proof.leaf, proof.proof, proof.root)).toBe(true);
    });
  });

  test('detects tampering when agenda changes', () => {
    const proof = generateMembershipProof(sampleMeeting.items, 0, sampleMeeting.salt);
    const alteredLeaf = computeLeafHash({
      agenda: 'Tampered agenda',
      notes: sampleMeeting.items[0].notes,
    }, sampleMeeting.salt);
    expect(verifyProof(alteredLeaf, proof.proof, proof.root)).toBe(false);
  });
});

describe('Meeting IO', () => {
  test('normalizes CRLF newlines in agenda and notes', () => {
    const meeting = parseMeetingRecord({
      meeting_id: 'A',
      timestamp: '2024-01-01T00:00:00Z',
      items: [
        {
          agenda: 'Line one\r\nLine two',
          notes: 'Note one\r\nNote two',
        },
      ],
    });
    expect(meeting.items[0].agenda).toBe('Line one\nLine two');
    expect(meeting.items[0].notes).toBe('Note one\nNote two');
  });

  test('verifyMeeting fails when provided root is incorrect', () => {
    const goodRoot = computeRootForMeeting(sampleMeeting);
    expect(goodRoot).toBeTruthy();
    expect(verifyMeeting(sampleMeeting, goodRoot)).toBe(true);
    expect(verifyMeeting(sampleMeeting, '0'.repeat(64))).toBe(false);
  });
});
