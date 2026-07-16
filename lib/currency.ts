// Formats a numeric amount as Brazilian Reais (e.g. "R$ 906,47"). Amounts in
// this system are stored in reais as decimals (not cents), so the value is
// passed straight to Intl with no unit conversion. Mirrors the financer app's
// numberToCurrency so AI-generated text matches what the UI shows. The NBSP
// Intl inserts between "R$" and the number is normalized to a plain space.
export function formatBRL(value: number): string {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    })
        .format(Number.isFinite(value) ? value : 0)
        .replace(/ /g, ' ');
}
