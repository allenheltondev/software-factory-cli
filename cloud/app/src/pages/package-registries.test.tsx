import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type PackageRegistriesView } from '../api/client';
import { PackageRegistries } from '../components/PackageRegistries';

const base: PackageRegistriesView = { hosts: ['npm.pkg.github.com'], defaults: ['registry.npmjs.org', 'pypi.org'], max: 20, canEdit: true, version: 3 };

describe('package registries (#157)', () => {
  it('lets an owner save the list over the loaded version, one host per line', async () => {
    const user = userEvent.setup();
    const setPackageRegistries = vi.fn(async (_: number, hosts: string[]) => ({ ...base, hosts, version: 4 }));
    render(<PackageRegistries api={{ packageRegistries: vi.fn().mockResolvedValue(base), setPackageRegistries }} installationId={55} />);
    const box = await screen.findByRole('textbox', { name: /Extra registry hosts/ });
    expect(box).toHaveValue('npm.pkg.github.com');
    expect(screen.getByRole('button', { name: 'Save registries' })).toBeDisabled();
    await user.type(box, '\n\n  acme.jfrog.io  ');
    await user.click(screen.getByRole('button', { name: 'Save registries' }));
    expect(setPackageRegistries).toHaveBeenCalledWith(55, ['npm.pkg.github.com', 'acme.jfrog.io'], 3);
    expect(await screen.findByText(/next subscription job uses this list/)).toBeInTheDocument();
    expect(screen.getByText(/uploads as well as downloads/)).toBeInTheDocument();
  });

  it("shows the server's reason when a host is refused", async () => {
    const user = userEvent.setup();
    const setPackageRegistries = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_settings', '"10.0.0.1" is not a host name'));
    render(<PackageRegistries api={{ packageRegistries: vi.fn().mockResolvedValue(base), setPackageRegistries }} installationId={55} />);
    await user.type(await screen.findByRole('textbox', { name: /Extra registry hosts/ }), '\n10.0.0.1');
    await user.click(screen.getByRole('button', { name: 'Save registries' }));
    expect(await screen.findByText('"10.0.0.1" is not a host name')).toBeInTheDocument();
  });

  it('is read-only for members, and says when the saved list is not applied', async () => {
    render(<PackageRegistries api={{ packageRegistries: vi.fn().mockResolvedValue({ ...base, canEdit: false, problem: 'The saved list is not valid any more, so jobs reach the default registries only.' }), setPackageRegistries: vi.fn() }} installationId={55} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Extra registry hosts/ })).toHaveAttribute('readonly'));
    expect(screen.queryByRole('button', { name: 'Save registries' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an installation owner/)).toBeInTheDocument();
    expect(screen.getByText(/default registries only/)).toBeInTheDocument();
  });
});
