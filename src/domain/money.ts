const MAX_AMOUNT = 1_000_000_000_000_000n;

export class VndValidationError extends Error {
  constructor(public readonly pointer: string, public readonly code: string) {
    super(`Invalid VND value (${code}).`);
    this.name = 'VndValidationError';
  }
}

type DraftLine = { quantity: string | null; unitPrice: string | null };
type CalculatedDraftLine = DraftLine & { amount: string | null };

export class VndCalculator {
  parseQuantity(value: string): string {
    return this.parse(value, '/quantity', true);
  }

  parseUnitPrice(value: string): string {
    return this.parse(value, '/unitPrice', false);
  }

  calculateLine(quantity: string, unitPrice: string): { quantity: string; unitPrice: string; amount: string } {
    const normalizedQuantity = this.parseQuantity(quantity);
    const normalizedPrice = this.parseUnitPrice(unitPrice);
    return {
      quantity: normalizedQuantity,
      unitPrice: normalizedPrice,
      amount: this.amount(normalizedQuantity, normalizedPrice, '/amount').toString(),
    };
  }

  calculateQuotation(lines: readonly DraftLine[]): {
    lines: CalculatedDraftLine[];
    complete: boolean;
    subtotal: string;
    total: string | null;
  } {
    if (lines.length > 1000) throw new VndValidationError('/lines', 'NUMERIC_LIMIT');
    let complete = lines.length > 0;
    let subtotal = 0n;
    const calculated = lines.map((line, index): CalculatedDraftLine => {
      const pointer = `/lines/${index}`;
      const quantity = line.quantity === null ? null : this.parse(line.quantity, `${pointer}/quantity`, true);
      const unitPrice = line.unitPrice === null ? null : this.parse(line.unitPrice, `${pointer}/unitPrice`, false);
      if (quantity === null || unitPrice === null) {
        complete = false;
        return { quantity, unitPrice, amount: null };
      }
      const amount = this.amount(quantity, unitPrice, `${pointer}/amount`);
      subtotal += amount;
      if (subtotal > MAX_AMOUNT) throw new VndValidationError('/total', 'NUMERIC_LIMIT');
      return { quantity, unitPrice, amount: amount.toString() };
    });
    return { lines: calculated, complete, subtotal: subtotal.toString(), total: complete ? subtotal.toString() : null };
  }

  private parse(value: string, pointer: string, quantity: boolean): string {
    if (value === null || value === '') throw new VndValidationError(pointer, 'REQUIRED');
    const match = typeof value === 'string' ? /^([0-9]+)(?:\.([0-9]+))?$/.exec(value) : null;
    if (!match || match[0] !== value) throw new VndValidationError(pointer, 'INVALID_DECIMAL');
    const whole = match[1]!.replace(/^0+/, '') || '0';
    const suppliedFraction = match[2];
    const fraction = suppliedFraction?.replace(/0+$/, '') ?? '';
    if (quantity ? fraction.length > 2 : suppliedFraction !== undefined) {
      throw new VndValidationError(pointer, 'PRECISION_EXCEEDED');
    }
    // Bound significant digits before BigInt; padding does not change valid wire values.
    if (whole.length > (quantity ? 7 : 13)) throw new VndValidationError(pointer, 'NUMERIC_LIMIT');
    const parsed = quantity ? BigInt(whole + fraction.padEnd(2, '0')) : BigInt(whole);
    if (quantity ? parsed <= 0n || parsed > 100_000_000n : parsed > 1_000_000_000_000n) {
      throw new VndValidationError(pointer, 'NUMERIC_LIMIT');
    }
    return fraction ? `${whole}.${fraction}` : whole;
  }

  private amount(quantity: string, unitPrice: string, pointer: string): bigint {
    const [whole, fraction = ''] = quantity.split('.');
    const hundredths = BigInt(whole! + fraction.padEnd(2, '0'));
    const amount = (hundredths * BigInt(unitPrice) + 50n) / 100n;
    if (amount > MAX_AMOUNT) throw new VndValidationError(pointer, 'NUMERIC_LIMIT');
    return amount;
  }
}
