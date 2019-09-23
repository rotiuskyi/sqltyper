--- setup -----------------------------------------------------------------

CREATE TABLE person (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  age integer
);

--- query -----------------------------------------------------------------

SELECT * FROM person

--- expected row count ----------------------------------------------------

many

--- expected column types -------------------------------------------------

id: number
name: string
age: number | null

--- expected param types --------------------------------------------------
