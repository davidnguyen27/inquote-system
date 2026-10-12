import assert from 'node:assert/strict';
import test from 'node:test';
import * as money from '../../dist/domain/money.js';

function calculator() {
  assert.equal(typeof money.VndCalculator, 'function', 'exact VND calculator is exported');
  return new money.VndCalculator();
}

function rejects(run, pointer, code) {
  assert.throws(run, error => {
    assert.ok(error instanceof money.VndValidationError);
    assert.equal(error.pointer, pointer);
    assert.equal(error.code, code);
    return true;
  });
}

test('quantity and price parsers canonicalize permitted zero padding', () => {
  const engine = calculator();
  for (const [value, expected] of [['001.2300', '1.23'], ['0.50', '0.5'], ['0001', '1'], ['1000000.000', '1000000'], ['0.0100', '0.01']]) {
    assert.equal(engine.parseQuantity(value), expected);
  }
  assert.equal(engine.parseUnitPrice('000100'), '100');
  assert.equal(engine.parseUnitPrice('000'), '0');
  assert.equal(engine.parseUnitPrice('1000000000000'), '1000000000000');
  assert.equal(engine.parseQuantity('0'.repeat(10000) + '1.23' + '0'.repeat(10000)), '1.23');
  assert.equal(engine.parseUnitPrice('0'.repeat(10000) + '100'), '100');
});

test('line amounts use exact half-up rounding and preserve normalized inputs', () => {
  const engine = calculator();
  for (const [quantity, unitPrice, expectedQuantity, amount] of [
    ['1.25', '123456', '1.25', '154320'],
    ['0.50', '101', '0.5', '51'],
    ['0.01', '49', '0.01', '0'],
    ['0.01', '50', '0.01', '1'],
    ['0.01', '51', '0.01', '1'],
    ['2.50', '0', '2.5', '0'],
    ['001.2300', '000100', '1.23', '123'],
    ['1000', '1000000000000', '1000', '1000000000000000'],
    ['1000000', '1000000000', '1000000', '1000000000000000'],
  ]) {
    assert.deepEqual(engine.calculateLine(quantity, unitPrice), {
      quantity: expectedQuantity,
      unitPrice: unitPrice === '000100' ? '100' : unitPrice,
      amount,
    });
  }
});

test('quotation sums rounded amounts rather than rounding the combined product', () => {
  const result = calculator().calculateQuotation([
    { quantity: '0.50', unitPrice: '101' },
    { quantity: '0.50', unitPrice: '101' },
  ]);
  assert.deepEqual(result, {
    lines: [
      { quantity: '0.5', unitPrice: '101', amount: '51' },
      { quantity: '0.5', unitPrice: '101', amount: '51' },
    ],
    complete: true, subtotal: '102', total: '102',
  });
});

test('malformed wire values are rejected without coercion or leaking supplied values', () => {
  const engine = calculator();
  for (const value of ['-1', '+1', '1e3', '1,25', ' 1', '1 ', '1\n', '.5', '1.', 'NaN', 'Infinity', '١', '１', 'private input', 1, {}, undefined]) {
    for (const [method, pointer] of [['parseQuantity', '/quantity'], ['parseUnitPrice', '/unitPrice']]) {
      rejects(() => engine[method](value), pointer, 'INVALID_DECIMAL');
    }
  }
  assert.throws(() => engine.parseQuantity('private input'), error => !error.message.includes('private input'));
  for (const value of ['', null]) {
    rejects(() => engine.parseQuantity(value), '/quantity', 'REQUIRED');
    rejects(() => engine.parseUnitPrice(value), '/unitPrice', 'REQUIRED');
  }
});

test('unsupported input precision is rejected after quantity trailing-zero normalization', () => {
  const engine = calculator();
  for (const quantity of ['1.234', '0.001', '1.23400']) {
    rejects(() => engine.parseQuantity(quantity), '/quantity', 'PRECISION_EXCEEDED');
  }
  for (const unitPrice of ['100.5', '100.0']) {
    rejects(() => engine.parseUnitPrice(unitPrice), '/unitPrice', 'PRECISION_EXCEEDED');
  }
});

test('input and rounded-line ceilings reject overflow including the maximum intermediate product', () => {
  const engine = calculator();
  for (const quantity of ['0', '000.000', '1000000.01', '9'.repeat(10000)]) {
    rejects(() => engine.parseQuantity(quantity), '/quantity', 'NUMERIC_LIMIT');
  }
  for (const price of ['1000000000001', '9'.repeat(10000)]) {
    rejects(() => engine.parseUnitPrice(price), '/unitPrice', 'NUMERIC_LIMIT');
  }
  rejects(() => engine.calculateLine('1000000', '1000000000000'), '/amount', 'NUMERIC_LIMIT');
  rejects(() => engine.calculateLine('1000.01', '1000000000000'), '/amount', 'NUMERIC_LIMIT');
});

test('incomplete drafts retain known rounded amounts and normalize every supplied field', () => {
  const lines = [
    { quantity: '0.50', unitPrice: '101' },
    { quantity: null, unitPrice: '000100' },
    { quantity: '001.2300', unitPrice: null },
    { quantity: null, unitPrice: null },
  ];
  assert.deepEqual(calculator().calculateQuotation(lines), {
    lines: [
      { quantity: '0.5', unitPrice: '101', amount: '51' },
      { quantity: null, unitPrice: '100', amount: null },
      { quantity: '1.23', unitPrice: null, amount: null },
      { quantity: null, unitPrice: null, amount: null },
    ],
    complete: false, subtotal: '51', total: null,
  });
  assert.equal(lines[0].quantity, '0.50');
});

test('empty and all-missing drafts have no total; complete zero-priced lines have a zero total', () => {
  const engine = calculator();
  assert.deepEqual(engine.calculateQuotation([]), { lines: [], complete: false, subtotal: '0', total: null });
  assert.deepEqual(engine.calculateQuotation([{ quantity: null, unitPrice: null }]), {
    lines: [{ quantity: null, unitPrice: null, amount: null }], complete: false, subtotal: '0', total: null,
  });
  assert.deepEqual(engine.calculateQuotation([{ quantity: '2.50', unitPrice: '0' }]), {
    lines: [{ quantity: '2.5', unitPrice: '0', amount: '0' }], complete: true, subtotal: '0', total: '0',
  });
});

test('missing counterparts do not excuse malformed supplied draft values', () => {
  const engine = calculator();
  rejects(() => engine.calculateQuotation([{ quantity: '1.234', unitPrice: null }]), '/lines/0/quantity', 'PRECISION_EXCEEDED');
  rejects(() => engine.calculateQuotation([{ quantity: null, unitPrice: 'secret-price' }]), '/lines/0/unitPrice', 'INVALID_DECIMAL');
  rejects(() => engine.calculateQuotation([{ quantity: '', unitPrice: null }]), '/lines/0/quantity', 'REQUIRED');
  rejects(() => engine.calculateQuotation([{ quantity: null, unitPrice: 0 }]), '/lines/0/unitPrice', 'INVALID_DECIMAL');
});

test('quotation enforces count, individual-line and known-subtotal ceilings even when incomplete', () => {
  const engine = calculator();
  const small = { quantity: '1', unitPrice: '1' };
  const maximum = { quantity: '1000', unitPrice: '1000000000000' };
  const missing = { quantity: null, unitPrice: null };
  assert.equal(engine.calculateQuotation(Array.from({ length: 1000 }, () => small)).total, '1000');
  rejects(() => engine.calculateQuotation(Array.from({ length: 1001 }, () => small)), '/lines', 'NUMERIC_LIMIT');
  assert.equal(engine.calculateQuotation([maximum]).total, '1000000000000000');
  assert.equal(engine.calculateQuotation([maximum, missing]).subtotal, '1000000000000000');
  rejects(() => engine.calculateQuotation([maximum, small]), '/total', 'NUMERIC_LIMIT');
  rejects(() => engine.calculateQuotation([missing, maximum, small]), '/total', 'NUMERIC_LIMIT');
  rejects(() => engine.calculateQuotation([{ quantity: '1000000', unitPrice: '1000000000000' }]), '/lines/0/amount', 'NUMERIC_LIMIT');
});
