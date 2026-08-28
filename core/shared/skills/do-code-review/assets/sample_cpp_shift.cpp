// Fixture guarding the heredoc language gate. `<<` here is stream insertion, not a heredoc
// opener, and the lone `total` line below is an expression statement, not a terminator.
// Without the gate this function scored complexity 1 instead of 7: every branch between the
// two was blanked as a heredoc body. See _blank_heredocs in code_quality_checker.py.
#include <iostream>

void report(int total) {
    std::cout << total
    if (total > 0 && total < 100) {
        for (int i = 0; i < total; i++) {
            if (i % 2) { log(i); }
        }
    }
    while (total-- > 0) {
        switch (total) { case 1: break; default: break; }
    }
    total
    ;
}
