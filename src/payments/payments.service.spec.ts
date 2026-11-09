import { toMinorUnits } from './payments.service';

describe('toMinorUnits', () => {
  it('converts decimal amounts to provider minor units', () => {
    expect(toMinorUnits('1500.00')).toBe(150000);
    expect(toMinorUnits('0.50')).toBe(50);
    expect(toMinorUnits('123.4')).toBe(12340);
    expect(toMinorUnits('99')).toBe(9900);
  });

  it('rejects malformed amounts', () => {
    expect(() => toMinorUnits('1.234')).toThrow('Invalid payment amount');
    expect(() => toMinorUnits('-1.00')).toThrow('Invalid payment amount');
  });
});
