CREATE TABLE test_data (id int NOT NULL PRIMARY KEY AUTO_INCREMENT, val int);

delete from test.test_data;

DELIMITER $$
CREATE PROCEDURE prepare_data()
BEGIN
  DECLARE i INT DEFAULT 1;

  WHILE i <= 150000 DO
    INSERT INTO test_data (val) VALUES (i);
    SET i = i + 1;
  END WHILE;
END$$
DELIMITER ;

CALL prepare_data();
DROP PROCEDURE prepare_data;


