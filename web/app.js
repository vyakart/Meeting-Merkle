(() => {
  const encoder = new TextEncoder();

  function showStatus(element, message, kind) {
    element.textContent = message;
    element.classList.toggle('ok', kind === 'ok');
    element.classList.toggle('error', kind === 'error');
    element.hidden = false;
  }

  function hideStatus(element) {
    element.hidden = true;
    element.textContent = '';
    element.classList.remove('ok', 'error');
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function canonicalizeString(value, field) {
    if (typeof value !== 'string') {
      throw new Error(`${field} must be a string`);
    }
    return value.replace(/\r\n?/g, '\n');
  }

  function validateTimestamp(value, field) {
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`${field} must be an ISO-8601 timestamp`);
    }
    return value;
  }

  function normalizeMeetingObject(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('Meeting must be a JSON object');
    }
    const meeting_id = canonicalizeString(raw.meeting_id, 'meeting_id');
    const timestamp = validateTimestamp(canonicalizeString(raw.timestamp, 'timestamp'), 'timestamp');
    const salt = raw.salt === undefined ? undefined : canonicalizeString(raw.salt, 'salt');
    const itemsValue = raw.items;
    if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
      throw new Error('items must be a non-empty array');
    }
    const items = itemsValue.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new Error(`items[${index}] must be an object`);
      }
      return {
        agenda: canonicalizeString(entry.agenda, `items[${index}].agenda`),
        notes: canonicalizeString(entry.notes, `items[${index}].notes`),
      };
    });
    return { meeting_id, timestamp, salt, items };
  }

  function parseMeetingText(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    return normalizeMeetingObject(json);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) {
      throw new Error('Hex value must be an even-length string');
    }
    const array = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      const byte = Number.parseInt(hex.slice(i, i + 2), 16);
      if (Number.isNaN(byte)) {
        throw new Error('Hex value contains non-hexadecimal characters');
      }
      array[i / 2] = byte;
    }
    return array;
  }

  async function hashBytes(bytes) {
    const buffer = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(buffer);
  }

  async function hashUtf8(text) {
    return hashBytes(encoder.encode(text));
  }

  async function hashLeaf(item, salt) {
    const payload = salt ? `${salt}\n${item.agenda}\n${item.notes}` : `${item.agenda}\n${item.notes}`;
    return hashUtf8(payload);
  }

  async function hashInternal(left, right) {
    const buffer = new Uint8Array(left.length + right.length);
    buffer.set(left, 0);
    buffer.set(right, left.length);
    return hashBytes(buffer);
  }

  async function buildLevels(items, salt) {
    let current = await Promise.all(items.map((item) => hashLeaf(item, salt)));
    const levels = [current];
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] ?? current[i];
        next.push(await hashInternal(left, right));
      }
      current = next;
      levels.push(current);
    }
    return levels;
  }

  async function buildMerkleTree(items, salt) {
    const levels = await buildLevels(items, salt);
    return {
      root: bytesToHex(levels[levels.length - 1][0]),
      leaves: levels[0].map(bytesToHex),
      layers: levels.map((level) => level.map(bytesToHex)),
      levels,
    };
  }

  function generateProofFromLevels(levels, index) {
    if (index < 0 || index >= levels[0].length) {
      throw new Error(`Leaf index ${index} is out of bounds`);
    }
    const proof = [];
    let currentIndex = index;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const layer = levels[level];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = layer[siblingIndex] ?? layer[currentIndex];
      proof.push({
        position: isRight ? 'left' : 'right',
        hash: bytesToHex(sibling),
      });
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  }

  async function generateProofDocument(meeting, index) {
    const { levels, root } = await buildMerkleTree(meeting.items, meeting.salt);
    return {
      meeting_id: meeting.meeting_id,
      timestamp: meeting.timestamp,
      salt: meeting.salt,
      index,
      item: meeting.items[index],
      leaf: bytesToHex(levels[0][index]),
      proof: generateProofFromLevels(levels, index),
      root,
    };
  }

  async function verifyProofDocument(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error('Proof must be a JSON object');
    }

    const { meeting_id, timestamp, salt, index, item, leaf, proof, root } = parsed;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new Error('Proof index must be a non-negative integer');
    }
    if (!Array.isArray(proof)) {
      throw new Error('Proof proof must be an array of steps');
    }

    const canonical = normalizeMeetingObject({
      meeting_id,
      timestamp,
      salt,
      items: [item],
    });
    const canonicalItem = canonical.items[0];
    const computedLeaf = bytesToHex(await hashLeaf(canonicalItem, canonical.salt));
    if (computedLeaf !== leaf.toLowerCase()) {
      throw new Error('Leaf hash does not match canonicalized item contents');
    }

    let computed = hexToBytes(computedLeaf);
    const rootBytes = hexToBytes(root);
    for (let i = 0; i < proof.length; i += 1) {
      const step = proof[i];
      if (!isPlainObject(step)) {
        throw new Error(`Proof step ${i} must be an object`);
      }
      const { position, hash } = step;
      if (position !== 'left' && position !== 'right') {
        throw new Error(`Proof step ${i} must specify position "left" or "right"`);
      }
      const sibling = hexToBytes(hash);
      computed = await hashInternal(position === 'left' ? sibling : computed, position === 'left' ? computed : sibling);
    }

    if (computed.length !== rootBytes.length) {
      throw new Error('Computed root length does not match expected root length');
    }
    for (let i = 0; i < computed.length; i += 1) {
      if (computed[i] !== rootBytes[i]) {
        throw new Error('Proof does not match the supplied root');
      }
    }
    return {
      root: root.toLowerCase(),
      leaf: computedLeaf,
      index,
    };
  }

  async function populateExample() {
    try {
      const response = await fetch('../examples/meeting.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      meetingInput.value = text;
      hideStatus(rootStatus);
      rootResult.hidden = true;
    } catch (error) {
      showStatus(rootStatus, `Failed to load example: ${error.message}`, 'error');
    }
  }

  const meetingInput = document.getElementById('meeting-json');
  const rootForm = document.getElementById('root-form');
  const rootStatus = document.getElementById('root-status');
  const rootResult = document.getElementById('root-result');
  const rootHash = document.getElementById('root-hash');
  const leafList = document.getElementById('leaf-list');
  const proofForm = document.getElementById('proof-form');
  const proofIndexInput = document.getElementById('proof-index');
  const proofStatus = document.getElementById('proof-status');
  const proofOutput = document.getElementById('proof-output');
  const verifyForm = document.getElementById('verify-form');
  const verifyInput = document.getElementById('verify-input');
  const verifyStatus = document.getElementById('verify-status');
  const exampleButton = document.getElementById('load-example');

  exampleButton.addEventListener('click', populateExample);

  rootForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideStatus(rootStatus);
    rootResult.hidden = true;
    try {
      const meeting = parseMeetingText(meetingInput.value.trim());
      const tree = await buildMerkleTree(meeting.items, meeting.salt);
      rootHash.textContent = tree.root;
      leafList.innerHTML = '';
      tree.leaves.forEach((hash, idx) => {
        const li = document.createElement('li');
        li.textContent = `Leaf ${idx}: ${hash}`;
        leafList.appendChild(li);
      });
      rootResult.hidden = false;
      showStatus(rootStatus, 'Computed Merkle root successfully.', 'ok');
    } catch (error) {
      showStatus(rootStatus, error.message, 'error');
    }
  });

  proofForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideStatus(proofStatus);
    proofOutput.value = '';
    try {
      const meeting = parseMeetingText(meetingInput.value.trim());
      const index = Number.parseInt(proofIndexInput.value, 10);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error('Index must be a non-negative integer');
      }
      if (index >= meeting.items.length) {
        throw new Error(`Index ${index} is out of bounds for items array of length ${meeting.items.length}`);
      }
      const proofDoc = await generateProofDocument(meeting, index);
      proofOutput.value = JSON.stringify(proofDoc, null, 2);
      showStatus(proofStatus, 'Generated membership proof.', 'ok');
    } catch (error) {
      showStatus(proofStatus, error.message, 'error');
    }
  });

  verifyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideStatus(verifyStatus);
    try {
      const result = await verifyProofDocument(verifyInput.value.trim());
      showStatus(verifyStatus, `Proof verified for root ${result.root}`, 'ok');
    } catch (error) {
      showStatus(verifyStatus, error.message, 'error');
    }
  });
})();
