<?php

declare(strict_types=1);

namespace Example\Library\Catalog;

use DateTimeImmutable;
use InvalidArgumentException;
use JsonSerializable;
use Example\Library\Contracts\{Repository, Clock};

/**
 * A small catalogue of books, written to exercise the PHP grammar: attributes,
 * enums, readonly promotion, match, closures, heredoc and nowdoc, interpolation,
 * regexes, SQL in strings and a template at the end.
 *
 * @template T of Book
 * @implements Repository<T>
 */
#[\Attribute(\Attribute::TARGET_CLASS)]
final class Catalogue implements Repository, JsonSerializable, \Countable
{
    use Logs, Caches {
        Caches::clear as protected clearCache;
    }

    public const int PAGE_SIZE = 25;
    private const string TABLE = 'books';

    /** @var array<string, Book> */
    private array $books = [];
    private static ?self $shared = null;

    public function __construct(
        private readonly Clock $clock,
        protected string $locale = 'en_GB',
        public ?int $limit = null,
    ) {
        $this->log("catalogue created for {$this->locale} at {$clock->now()->format('c')}");
    }

    public static function shared(Clock $clock): static
    {
        return self::$shared ??= new static($clock);
    }

    public function add(Book $book): void
    {
        if (isset($this->books[$book->isbn])) {
            throw new InvalidArgumentException(sprintf('Duplicate ISBN "%s"', $book->isbn));
        }
        $this->books[$book->isbn] = $book;
        $this->clearCache();
    }

    /** @return list<Book> */
    public function search(string $query, Genre ...$genres): array
    {
        $needle = mb_strtolower(trim($query));
        $matches = array_filter(
            $this->books,
            static fn (Book $b): bool => str_contains(mb_strtolower($b->title), $needle)
                && ($genres === [] || in_array($b->genre, $genres, true)),
        );
        usort($matches, function (Book $a, Book $b) use ($needle): int {
            $score = fn (Book $x) => similar_text($needle, mb_strtolower($x->title));
            return $score($b) <=> $score($a) ?: strcmp($a->title, $b->title);
        });
        return array_values($matches);
    }

    public function isbnIsValid(string $isbn): bool
    {
        if (!preg_match('/^(?:97[89])?\d{9}[\dX]$/', str_replace('-', '', $isbn))) {
            return false;
        }
        $digits = str_split(str_replace('-', '', $isbn));
        $sum = 0;
        foreach ($digits as $i => $digit) {
            $sum += ($digit === 'X' ? 10 : (int) $digit) * ($i % 2 === 0 ? 1 : 3);
        }
        return $sum % 10 === 0;
    }

    public function shelfFor(Book $book): string
    {
        return match (true) {
            $book->pages > 800 => 'bottom',
            $book->published < new DateTimeImmutable('1900-01-01') => 'archive',
            $book->genre === Genre::Poetry, $book->genre === Genre::Drama => 'left',
            default => 'main',
        };
    }

    public function query(int $page = 1): string
    {
        $offset = ($page - 1) * self::PAGE_SIZE;
        $table = self::TABLE;
        return <<<SQL
            SELECT isbn, title, author_id
              FROM {$table}
             WHERE deleted_at IS NULL
             ORDER BY title ASC
             LIMIT {$offset}, 25
            SQL;
    }

    public function banner(): string
    {
        $count = count($this);
        return <<<'TEXT'
            Nothing in a nowdoc is interpolated: $count stays as written.
            TEXT . "\n{$count} books\t(" . self::class . ')';
    }

    public function count(): int
    {
        return count($this->books);
    }

    public function jsonSerialize(): mixed
    {
        return [
            'locale' => $this->locale,
            'books' => array_map(static fn (Book $b): array => $b->toArray(), $this->books),
            'generated' => $this->clock->now()->getTimestamp(),
        ];
    }
}

enum Genre: string
{
    case Novel = 'novel';
    case Poetry = 'poetry';
    case Drama = 'drama';
    case Essay = 'essay';

    public function label(): string
    {
        return ucfirst($this->value);
    }
}

final readonly class Book
{
    public function __construct(
        public string $isbn,
        public string $title,
        public Genre $genre,
        public int $pages,
        public DateTimeImmutable $published,
    ) {}

    /** @return array{isbn: string, title: string, genre: string} */
    public function toArray(): array
    {
        return ['isbn' => $this->isbn, 'title' => $this->title, 'genre' => $this->genre->value];
    }
}

interface Shelf
{
    public function put(Book $book, int $position = 0): void;
}

abstract class Section implements Shelf
{
    abstract protected function name(): string;

    public function __toString(): string
    {
        return "Section: {$this->name()} (" . static::class . ")";
    }
}

$catalogue = Catalogue::shared(new class implements Clock {
    public function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('@0');
    }
});
$catalogue->add(new Book('978-0-00-000000-2', 'An Example', Genre::Essay, 120, new DateTimeImmutable()));
$titles = array_column($catalogue->jsonSerialize()['books'], 'title');
// A trailing comment, # another, and /* a block */ to finish.
?>
<!doctype html>
<html lang="<?= htmlspecialchars('en') ?>">
<body>
  <h1>Catalogue (<?= count($catalogue) ?>)</h1>
  <ul class="books">
    <?php foreach ($titles as $i => $title): ?>
      <li data-index="<?= $i ?>"><?= htmlspecialchars($title, ENT_QUOTES) ?></li>
    <?php endforeach; ?>
  </ul>
  <script>
    document.querySelectorAll('.books li').forEach((li) => li.addEventListener('click', () => li.remove()));
  </script>
  <style>
    .books li:hover { color: #c00; text-decoration: underline; }
  </style>
</body>
</html>
