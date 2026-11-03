<?php

namespace App\Platform\Games;

use Illuminate\Contracts\Container\Container;

/** The registry of game modules (config/games.php) and which of them a client may play. */
final class Games
{
    public function __construct(private Container $container, private array $config) {}

    /** @return list<string> every game id this server has */
    public function ids(): array
    {
        return array_keys($this->config['modules'] ?? []);
    }

    public function exists(string $id): bool
    {
        return isset($this->config['modules'][$id]);
    }

    public function get(string $id): GameModule
    {
        if (! $this->exists($id)) {
            throw new \InvalidArgumentException("unknown game $id");
        }

        return $this->container->make($this->config['modules'][$id]);
    }

    /** @return array<string,GameModule> */
    public function all(): array
    {
        $out = [];
        foreach ($this->ids() as $id) {
            $out[$id] = $this->get($id);
        }

        return $out;
    }

    /** @return list<string> the games a client plays when it has no list of its own */
    public function defaults(): array
    {
        return array_values($this->config['default'] ?? ['horse-race']);
    }

    /**
     * The games a client may play: its own "games" list, or the defaults when it has none. A client whose list names a game this server no longer has plays without it.
     *
     * @param  array  $client  a client of the registry (App\Game\Clients\ClientRegistry::get)
     * @return list<string>
     */
    public function enabledFor(array $client): array
    {
        $own = $client['games'] ?? null;

        return array_values(array_filter(is_array($own) ? $own : $this->defaults(), fn ($g) => $this->exists($g)));
    }

    public function isEnabled(array $client, string $gameId): bool
    {
        return in_array($gameId, $this->enabledFor($client), true);
    }
}
