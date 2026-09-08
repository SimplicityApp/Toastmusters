import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BillingSuccess from './BillingSuccess';
import BillingCancel from './BillingCancel';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BillingSuccess', () => {
  it('asks the Worker whether the session was paid and says so', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ paid: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/billing/success?session_id=cs_test_1']}>
        <BillingSuccess />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('You are on Pro')).toBeInTheDocument());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/billing/checkout-status?session_id=cs_test_1');
  });

  it('stays reassuring when the status is not confirmed yet or the id is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ paid: false }) })));
    render(
      <MemoryRouter initialEntries={['/billing/success?session_id=cs_test_2']}>
        <BillingSuccess />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Payment received, activating…')).toBeInTheDocument());

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/billing/success']}>
        <BillingSuccess />
      </MemoryRouter>
    );
    expect(screen.getByText('Thanks for subscribing')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('BillingCancel', () => {
  it('says nothing was charged', () => {
    render(
      <MemoryRouter initialEntries={['/billing/cancel']}>
        <BillingCancel />
      </MemoryRouter>
    );
    expect(screen.getByText('No charge was made')).toBeInTheDocument();
  });
});
