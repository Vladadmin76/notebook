-- Вид карты: «tree» (дерево, раскладывается само) или «board» (доска: окошки ставит сам человек, линии идут от одного к другому)
ALTER TABLE mind_maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'tree';
